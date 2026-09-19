"""Render a selector run (or several) as markdown tables.

    python3 selector/report.py runs/zs-01.json runs/lr-01.json runs/ft-01.json

Prints: one accuracy table across variants and evaluation sets, per-category
accuracy on the suite, the top confused pairs, and the calibration sweep for
the best variant. ``--per-op <variant>`` adds the per-operation precision and
recall table for one variant.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

SETS = ("val", "dev_paraphrase", "suite")
CATEGORIES = (
    "single_read",
    "single_write",
    "cross_app_one_call",
    "chain",
    "follow_up",
    "reference_into_result",
    "refusal_none",
)


def load(paths: list[str]) -> dict[str, dict]:
    variants: dict[str, dict] = {}
    for path in paths:
        payload = json.loads(Path(path).read_text())
        for variant, sets in payload["results"].items():
            variants[variant] = {"sets": sets, "run": Path(path).stem, "payload": payload}
    return variants


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="+")
    parser.add_argument("--per-op")
    args = parser.parse_args()
    variants = load(args.runs)

    print("### Accuracy\n")
    print("| variant | run | val | dev_paraphrase | suite |")
    print("| --- | --- | --- | --- | --- |")
    for name, entry in variants.items():
        cells = " | ".join(f"{entry['sets'][s]['accuracy']:.3f}" for s in SETS)
        print(f"| `{name}` | {entry['run']} | {cells} |")

    print("\n### Suite accuracy by category\n")
    header = " | ".join(CATEGORIES)
    print(f"| variant | {header} |")
    print("| --- |" + " --- |" * len(CATEGORIES))
    for name, entry in variants.items():
        by_category = entry["sets"]["suite"]["by_category"]
        cells = " | ".join(
            f"{by_category[c]['accuracy']:.2f} ({int(by_category[c]['correct'])}/{int(by_category[c]['n'])})"
            if c in by_category
            else "-"
            for c in CATEGORIES
        )
        print(f"| `{name}` | {cells} |")

    print("\n### Top confusions on the suite\n")
    for name, entry in variants.items():
        pairs = entry["sets"]["suite"]["top_confusions"][:6]
        formatted = ", ".join(f"`{pair}` x{count}" for pair, count in pairs)
        print(f"- `{name}`: {formatted or 'none'}")

    for name, entry in variants.items():
        calibration = entry["payload"].get("calibration", {})
        key = f"{name}|suite"
        if key not in calibration:
            continue
        print(f"\n### Calibration sweep --- `{name}` on the suite\n")
        print("| margin | coverage | accuracy on answered | accuracy if deferral counts wrong |")
        print("| --- | --- | --- | --- |")
        for row in calibration[key]:
            print(
                f"| {row['margin_threshold']} | {row['coverage']:.3f} | {row['accuracy_on_answered']:.3f} | "
                f"{row['accuracy_overall_if_deferred_counts_wrong']:.3f} |"
            )

    if args.per_op:
        entry = variants[args.per_op]
        print(f"\n### Per-operation precision/recall --- `{args.per_op}` on the suite\n")
        print("| operation | support | precision | recall |")
        print("| --- | --- | --- | --- |")
        for operation, stats in sorted(entry["sets"]["suite"]["per_label"].items()):
            if not stats["support"]:
                continue
            print(f"| `{operation}` | {int(stats['support'])} | {stats['precision']:.2f} | {stats['recall']:.2f} |")


if __name__ == "__main__":
    main()
