"""Zero-shot selector baselines over frozen sentence embeddings.

Two retrieval families, no training:

- ``description`` --- cosine between the rendered turn and one document per
  label built from the catalogue (name, app, kind, description). This is the
  honest zero-shot baseline: it uses only what the catalogue documents.
- ``knn`` --- k-nearest neighbours over ``train.jsonl``. Strictly this *sees*
  generated data, but it fits no parameters; it is reported as the retrieval
  ceiling a runtime could get with an index and no training step.

Each family runs over the three input renderings (``request``, ``json``,
``context``) so the value of the previous turn is measured rather than assumed.

    python3 selector/run_zero_shot.py --label zs-01
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np

import common


def predict_description(rows, mode, doc_vectors, names):  # noqa: ANN001, ANN201
    vectors = common.encode([common.render(row, mode) for row in rows])
    scores = vectors @ doc_vectors.T
    return [names[int(i)] for i in scores.argmax(axis=1)], scores


def predict_knn(rows, mode, train_vectors, train_labels, k):  # noqa: ANN001, ANN201
    vectors = common.encode([common.render(row, mode) for row in rows])
    scores = vectors @ train_vectors.T
    predictions = []
    for row_scores in scores:
        top = np.argpartition(-row_scores, k)[:k]
        top = top[np.argsort(-row_scores[top])]
        weights: dict[str, float] = {}
        for index in top:
            weights[train_labels[index]] = weights.get(train_labels[index], 0.0) + float(row_scores[index])
        predictions.append(max(weights.items(), key=lambda kv: kv[1])[0])
    return predictions, scores


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--k", type=int, default=5)
    args = parser.parse_args()

    started = time.time()
    data = common.datasets()
    names, documents = common.operation_documents()
    labels = names

    doc_vectors = common.encode(documents)
    results: dict[str, dict[str, object]] = {}

    for mode in ("request", "json", "context"):
        train_vectors = common.encode([common.render(row, mode) for row in data["train"]])
        train_labels = [str(row["label"]) for row in data["train"]]
        for family in ("description", "knn"):
            variant = f"{family}:{mode}"
            per_set: dict[str, object] = {}
            for name in ("val", "dev_paraphrase", "suite"):
                rows = data[name]
                if family == "description":
                    predictions, _ = predict_description(rows, mode, doc_vectors, names)
                else:
                    predictions, _ = predict_knn(rows, mode, train_vectors, train_labels, args.k)
                per_set[name] = common.score(rows, predictions, labels)
                print(f"{variant:24s} {name:15s} acc={per_set[name]['accuracy']:.3f}")
            results[variant] = per_set

    payload = {
        "lane": "selector",
        "kind": "zero_shot",
        "embedder": common.EMBEDDER,
        "k": args.k,
        "wall_clock_seconds": round(time.time() - started, 1),
        "results": results,
    }
    path = common.save_run(args.label, payload)
    print(f"\nwrote {path}")
    print(json.dumps({v: {s: r[s]["accuracy"] for s in r} for v, r in results.items()}, indent=1))


if __name__ == "__main__":
    main()
