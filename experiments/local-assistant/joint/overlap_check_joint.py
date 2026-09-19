"""The selector lane's lexical-overlap guard, run over the joint lane's files.

Same rule, same threshold, same proper-noun list: no generated utterance (or
previous-turn utterance) may exceed token-Jaccard 0.8 against any suite turn
or any catalogue ``example_utterances`` entry, and none may contain a proper
noun from the suite world. Offenders are a failure, not a report.

    .venv-joint/bin/python joint/overlap_check_joint.py --write
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "selector"))

from overlap_check import SUITE_PROPER_NOUNS, THRESHOLD, jaccard, reference_corpus, tokens  # noqa: E402

FILES = ("train.jsonl", "val.jsonl", "dev_joint.jsonl")


def generated() -> list[tuple[str, str]]:
    corpus: list[tuple[str, str]] = []
    for name in FILES:
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
    offenders: list[dict[str, object]] = []
    leaks: list[dict[str, str]] = []
    worst, worst_pair = 0.0, None
    seen: set[str] = set()
    for source, text in generated():
        if text in seen:
            continue
        seen.add(text)
        bag = tokens(text)
        leaked = bag & SUITE_PROPER_NOUNS
        if leaked:
            leaks.append({"source": source, "text": text, "tokens": ",".join(sorted(leaked))})
        for ref_source, ref_text, ref_bag in reference:
            score = jaccard(bag, ref_bag)
            if score > worst:
                worst, worst_pair = score, (text, ref_text)
            if score > THRESHOLD:
                offenders.append({"source": source, "text": text, "against": ref_source, "jaccard": round(score, 3)})

    report = {
        "lane": "joint",
        "threshold": THRESHOLD,
        "generated_unique_utterances": len(seen),
        "reference_utterances": len(reference),
        "offenders": offenders,
        "proper_noun_leaks": leaks,
        "max_jaccard": round(worst, 3),
        "max_jaccard_pair": list(worst_pair) if worst_pair else None,
    }
    print(json.dumps({k: v for k, v in report.items() if k not in {"offenders", "proper_noun_leaks"}}, indent=1))
    print(f"offenders: {len(offenders)}  proper-noun leaks: {len(leaks)}")
    if args.write:
        (HERE / "overlap_report_joint.json").write_text(json.dumps(report, indent=1) + "\n")
    if offenders or leaks:
        for item in (offenders + leaks)[:10]:
            print("  ", item)
        sys.exit(1)


if __name__ == "__main__":
    main()
