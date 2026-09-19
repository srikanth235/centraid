"""Lexical-overlap guard between generated data and the frozen evaluation.

Training data must never see the suite. The rule enforced here: no generated
or dev-set utterance may have token-Jaccard > 0.8 against any suite utterance
(``suite.json``, every turn) or against any ``example_utterances`` entry in the
catalogue --- those are documentation, never training text. A second, stricter
check flags any generated utterance containing a proper noun that belongs to
the suite world (Neha, Initech, Goa, ...), since a name can leak without
moving Jaccard much.

    python3 selector/overlap_check.py --write

Writes ``overlap_report.json``; a non-empty ``offenders`` list is a failure and
exits non-zero.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
THRESHOLD = 0.8

SUITE_PROPER_NOUNS = {
    "neha",
    "kulkarni",
    "bhatt",
    "marcus",
    "reed",
    "oyelaran",
    "priya",
    "raman",
    "dev",
    "sharma",
    "rhea",
    "fernandes",
    "tomas",
    "vidal",
    "lena",
    "ostrowski",
    "arjun",
    "menon",
    "sofia",
    "duarte",
    "ibrahim",
    "qadir",
    "grace",
    "whitfield",
    "kenji",
    "sato",
    "anya",
    "petrova",
    "initech",
    "hooli",
    "acme",
    "goa",
    "bangalore",
    "indiranagar",
    "koramangala",
    "reykjavik",
    "lisbon",
    "migration",
    "contracts",
    "receipts",
    "offsite",
    "visa",
}


def tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def reference_corpus() -> list[tuple[str, str]]:
    corpus: list[tuple[str, str]] = []
    suite = json.loads((ROOT / "suite.json").read_text())
    for case in suite["cases"]:
        for turn in case["turns"]:
            corpus.append((f"suite:{case['id']}", turn["request"]))
    catalogue = json.loads((ROOT / "catalogue.json").read_text())
    for operation in catalogue["operations"]:
        for utterance in operation.get("example_utterances", []):
            corpus.append((f"catalogue:{operation['name']}", utterance))
    return corpus


def generated_corpus() -> list[tuple[str, str]]:
    corpus: list[tuple[str, str]] = []
    for name in ("train.jsonl", "val.jsonl", "dev_paraphrase.jsonl"):
        path = HERE / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            row = json.loads(line)
            corpus.append((name, str(row["request"])))
            if row.get("previous_request"):
                corpus.append((name, str(row["previous_request"])))
    return corpus


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()

    reference = [(source, text, tokens(text)) for source, text in reference_corpus()]
    generated = generated_corpus()

    offenders: list[dict[str, object]] = []
    worst = 0.0
    worst_pair: tuple[str, str] | None = None
    proper_noun_hits: list[dict[str, str]] = []

    seen: set[str] = set()
    for source, text in generated:
        if text in seen:
            continue
        seen.add(text)
        bag = tokens(text)
        leaked = bag & SUITE_PROPER_NOUNS
        if leaked:
            proper_noun_hits.append({"source": source, "text": text, "tokens": ",".join(sorted(leaked))})
        for ref_source, ref_text, ref_bag in reference:
            score = jaccard(bag, ref_bag)
            if score > worst:
                worst, worst_pair = score, (text, ref_text)
            if score > THRESHOLD:
                offenders.append(
                    {"source": source, "text": text, "against": ref_source, "reference": ref_text, "jaccard": round(score, 3)}
                )

    report = {
        "threshold": THRESHOLD,
        "generated_unique_utterances": len(seen),
        "reference_utterances": len(reference),
        "offenders": offenders,
        "proper_noun_leaks": proper_noun_hits,
        "max_jaccard": round(worst, 3),
        "max_jaccard_pair": list(worst_pair) if worst_pair else None,
    }
    print(json.dumps({k: v for k, v in report.items() if k not in {"offenders", "proper_noun_leaks"}}, indent=1))
    print(f"offenders: {len(offenders)}  proper-noun leaks: {len(proper_noun_hits)}")
    if args.write:
        (HERE / "overlap_report.json").write_text(json.dumps(report, indent=1) + "\n")
    if offenders or proper_noun_hits:
        for item in (offenders + proper_noun_hits)[:10]:
            print("  ", item)
        sys.exit(1)


if __name__ == "__main__":
    main()
