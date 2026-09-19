"""Trained selectors: logistic regression over frozen embeddings, and an
optional end-to-end fine-tune of the same small encoder.

Feature variants for the logistic regression, all over the frozen MiniLM
embeddings, so the difference between them is only *what the selector is told*:

- ``request``   --- embedding of the request alone (no context at all).
- ``context``   --- embedding of the prose context rendering.
- ``fields``    --- embedding(request) + embedding(previous_request) +
  a one-hot of ``previous_operation``. The one-hot is the point: a bare
  follow-up like "only the ones with X" has no lexical cue, and a 48-way
  indicator is a far cleaner carrier for the previous operation than hoping
  the encoder reads an operation name out of a JSON string.

``--finetune`` additionally trains the encoder itself with a classification
head (mean pooling, cross-entropy) on the ``fields`` text rendering, with the
previous operation appended as words. CPU, a few minutes.

Calibration: for the best variant the run records accuracy and coverage at a
sweep of probability-margin thresholds, where a turn below the threshold is
routed to ``clarify`` --- the runtime's "show the operation and its siblings"
path.

    python3 selector/run_trained.py --label lr-01
    python3 selector/run_trained.py --label ft-01 --finetune
"""

from __future__ import annotations

import argparse
import json
import pickle
import time
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression

import common

HERE = Path(__file__).resolve().parent


def one_hot(rows, operations):  # noqa: ANN001, ANN201
    index = {name: i for i, name in enumerate(operations)}
    matrix = np.zeros((len(rows), len(operations) + 1), dtype=np.float32)
    for position, row in enumerate(rows):
        previous = row.get("previous_operation")
        matrix[position, index[previous] if previous in index else len(operations)] = 1.0
    return matrix


def features(rows, variant, operations):  # noqa: ANN001, ANN201
    if variant in ("request", "context"):
        return common.encode([common.render(row, variant) for row in rows])
    if variant == "fields":
        request = common.encode([str(row["request"]) for row in rows])
        previous = common.encode([str(row.get("previous_request") or "") for row in rows])
        return np.hstack([request, previous, one_hot(rows, operations)])
    raise ValueError(variant)


def calibration(probabilities, gold, classes, thresholds):  # noqa: ANN001, ANN201
    """Accuracy over answered turns and coverage, as a margin threshold rises."""
    order = np.argsort(-probabilities, axis=1)
    top = probabilities[np.arange(len(gold)), order[:, 0]]
    second = probabilities[np.arange(len(gold)), order[:, 1]]
    margin = top - second
    predictions = [classes[i] for i in order[:, 0]]
    report = []
    for threshold in thresholds:
        answered = margin >= threshold
        count = int(answered.sum())
        correct = sum(1 for i in range(len(gold)) if answered[i] and predictions[i] == gold[i])
        report.append(
            {
                "margin_threshold": threshold,
                "coverage": round(count / len(gold), 3),
                "accuracy_on_answered": round(correct / count, 3) if count else 0.0,
                "accuracy_overall_if_deferred_counts_wrong": round(correct / len(gold), 3),
            }
        )
    return report


def finetune(data, operations, epochs, seed):  # noqa: ANN001, ANN201
    """Fine-tune the MiniLM encoder with a mean-pooled classification head."""
    import torch
    from torch import nn
    from transformers import AutoModel, AutoTokenizer

    torch.manual_seed(seed)
    torch.set_num_threads(4)
    labels = sorted({str(row["label"]) for row in data["train"]} | set(operations))
    index = {label: i for i, label in enumerate(labels)}

    def text(row):  # noqa: ANN001, ANN202
        return common.render(row, "context")

    tokenizer = AutoTokenizer.from_pretrained(common.EMBEDDER)
    encoder = AutoModel.from_pretrained(common.EMBEDDER)
    head = nn.Linear(encoder.config.hidden_size, len(labels))
    parameters = list(encoder.parameters()) + list(head.parameters())
    optimiser = torch.optim.AdamW(parameters, lr=3e-5)
    loss_fn = nn.CrossEntropyLoss()

    rows = data["train"]
    order = np.random.default_rng(seed).permutation(len(rows))
    batch_size = 32
    encoder.train()
    for epoch in range(epochs):
        total = 0.0
        for start in range(0, len(order), batch_size):
            batch = [rows[i] for i in order[start : start + batch_size]]
            encoded = tokenizer([text(r) for r in batch], padding=True, truncation=True, max_length=64, return_tensors="pt")
            target = torch.tensor([index[str(r["label"])] for r in batch])
            hidden = encoder(**encoded).last_hidden_state
            mask = encoded["attention_mask"].unsqueeze(-1).float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
            loss = loss_fn(head(pooled), target)
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()
            total += float(loss)
        print(f"  epoch {epoch + 1}: mean loss {total / max(1, len(order) // batch_size):.4f}")

    encoder.eval()

    def predict(subset):  # noqa: ANN001, ANN202
        out = []
        with torch.no_grad():
            for start in range(0, len(subset), 64):
                batch = subset[start : start + 64]
                encoded = tokenizer(
                    [text(r) for r in batch], padding=True, truncation=True, max_length=64, return_tensors="pt"
                )
                hidden = encoder(**encoded).last_hidden_state
                mask = encoded["attention_mask"].unsqueeze(-1).float()
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                out.append(torch.softmax(head(pooled), dim=-1).numpy())
        return np.vstack(out)

    return labels, predict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--finetune", action="store_true")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--save-artifact", action="store_true")
    args = parser.parse_args()

    started = time.time()
    data = common.datasets()
    operations, _ = common.operation_documents()
    thresholds = [0.0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7]
    results: dict[str, dict[str, object]] = {}
    calibrations: dict[str, object] = {}
    artifacts: dict[str, object] = {}

    for variant in ("request", "context", "fields"):
        train_x = features(data["train"], variant, operations)
        train_y = [str(row["label"]) for row in data["train"]]
        model = LogisticRegression(max_iter=3000, C=4.0, n_jobs=-1)
        model.fit(train_x, train_y)
        per_set: dict[str, object] = {}
        for name in ("val", "dev_paraphrase", "suite"):
            rows = data[name]
            matrix = features(rows, variant, operations)
            probabilities = model.predict_proba(matrix)
            predictions = [model.classes_[i] for i in probabilities.argmax(axis=1)]
            per_set[name] = common.score(rows, predictions, list(model.classes_))
            calibrations[f"logreg:{variant}|{name}"] = calibration(
                probabilities, [str(r["label"]) for r in rows], list(model.classes_), thresholds
            )
            print(f"logreg:{variant:8s} {name:15s} acc={per_set[name]['accuracy']:.3f}")
        results[f"logreg:{variant}"] = per_set
        artifacts[variant] = model

    if args.finetune:
        labels, predict = finetune(data, operations, args.epochs, seed=7)
        per_set = {}
        for name in ("val", "dev_paraphrase", "suite"):
            rows = data[name]
            probabilities = predict(rows)
            predictions = [labels[i] for i in probabilities.argmax(axis=1)]
            per_set[name] = common.score(rows, predictions, labels)
            calibrations[f"finetune|{name}"] = calibration(probabilities, [str(r["label"]) for r in rows], labels, thresholds)
            print(f"finetune            {name:15s} acc={per_set[name]['accuracy']:.3f}")
        results["finetune:context"] = per_set

    if args.save_artifact:
        directory = HERE / "artifacts" / args.label
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "logreg_fields.pkl").open("wb") as handle:
            pickle.dump({"model": artifacts["fields"], "operations": operations, "embedder": common.EMBEDDER}, handle)
        print(f"saved artifact to {directory}")

    payload = {
        "lane": "selector",
        "kind": "trained",
        "embedder": common.EMBEDDER,
        "finetune": args.finetune,
        "epochs": args.epochs if args.finetune else None,
        "wall_clock_seconds": round(time.time() - started, 1),
        "results": results,
        "calibration": calibrations,
    }
    path = common.save_run(args.label, payload)
    print(f"\nwrote {path}")
    print(json.dumps({v: {s: r[s]["accuracy"] for s in r} for v, r in results.items()}, indent=1))


if __name__ == "__main__":
    main()
