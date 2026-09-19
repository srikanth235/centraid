"""Shared plumbing for the selector lane: rendering, embedding, scoring, runs.

The embedder is ``sentence-transformers/all-MiniLM-L6-v2`` (22.7M parameters,
384 dimensions, ~90 MB on disk). It was chosen over a BGE-small-class model
because it is the smallest of the two candidates named in ``protocol.md`` and
encodes the whole lane (~8k short utterances) in seconds on four CPU cores.

Three input renderings, because the protocol's selector input has three fields
and it is an open question how much of it helps:

- ``request``  --- the request alone. Cannot answer a bare follow-up.
- ``json``     --- the protocol's JSON object verbatim.
- ``context``  --- a prose rendering of the same three fields, which keeps the
  previous operation as words the embedder has seen in pretraining rather than
  as a key/value pair.

A run is written to ``runs/<label>.json`` and an existing label is refused,
never overwritten, per the protocol's append-only rule.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Iterable, Sequence

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNS = ROOT / "runs"
EMBEDDER = "sentence-transformers/all-MiniLM-L6-v2"

os.environ.setdefault("SSL_CERT_FILE", "/root/.ccr/ca-bundle.crt")
os.environ.setdefault("REQUESTS_CA_BUNDLE", "/root/.ccr/ca-bundle.crt")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def datasets() -> dict[str, list[dict[str, Any]]]:
    return {
        "train": load_jsonl(HERE / "train.jsonl"),
        "val": load_jsonl(HERE / "val.jsonl"),
        "dev_paraphrase": load_jsonl(HERE / "dev_paraphrase.jsonl"),
        "suite": load_jsonl(HERE / "suite_selector.jsonl"),
    }


def render(row: dict[str, Any], mode: str) -> str:
    request = str(row["request"])
    previous_request = row.get("previous_request")
    previous_operation = row.get("previous_operation")
    if mode == "request":
        return request
    if mode == "json":
        return json.dumps(
            {
                "request": request,
                "previous_request": previous_request,
                "previous_operation": previous_operation,
            }
        )
    if mode == "context":
        if not previous_operation:
            return f"new conversation. user says: {request}"
        spoken = str(previous_operation).replace("_", " ")
        return f"after {spoken} for '{previous_request}'. user says: {request}"
    raise ValueError(f"unknown render mode {mode}")


def operation_documents() -> tuple[list[str], list[str]]:
    """One text per label, from the catalogue: name, app, kind, description."""
    catalogue = json.loads((ROOT / "catalogue.json").read_text())
    names: list[str] = []
    documents: list[str] = []
    for operation in catalogue["operations"]:
        names.append(operation["name"])
        documents.append(
            f"{operation['app']} {operation['kind']}: {operation['name'].replace('_', ' ')}. {operation['description']}"
        )
    for name, description in catalogue["non_operations"].items():
        names.append(name)
        documents.append(f"protocol outcome: {name}. {description}")
    return names, documents


_MODEL = None


def embedder():  # noqa: ANN201 - sentence_transformers type is not imported at module scope
    global _MODEL
    if _MODEL is None:
        from sentence_transformers import SentenceTransformer

        _MODEL = SentenceTransformer(EMBEDDER)
    return _MODEL


def encode(texts: Sequence[str], batch_size: int = 128):  # noqa: ANN201
    return embedder().encode(
        list(texts), batch_size=batch_size, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False
    )


def score(rows: Iterable[dict[str, Any]], predictions: Sequence[str], labels: Sequence[str]) -> dict[str, Any]:
    """Accuracy, per-label precision/recall, per-category accuracy, confusions."""
    rows = list(rows)
    gold = [str(r["label"]) for r in rows]
    correct = sum(1 for g, p in zip(gold, predictions) if g == p)
    per_label: dict[str, dict[str, float]] = {}
    for label in labels:
        true_positive = sum(1 for g, p in zip(gold, predictions) if g == label and p == label)
        predicted = sum(1 for p in predictions if p == label)
        actual = sum(1 for g in gold if g == label)
        if not actual and not predicted:
            continue
        per_label[label] = {
            "support": actual,
            "precision": round(true_positive / predicted, 3) if predicted else 0.0,
            "recall": round(true_positive / actual, 3) if actual else 0.0,
        }
    confusion: dict[str, int] = {}
    for g, p in zip(gold, predictions):
        if g != p:
            confusion[f"{g} -> {p}"] = confusion.get(f"{g} -> {p}", 0) + 1
    by_category: dict[str, dict[str, float]] = {}
    for row, g, p in zip(rows, gold, predictions):
        key = str(row.get("category") or row.get("kind") or "all")
        bucket = by_category.setdefault(key, {"n": 0, "correct": 0})
        bucket["n"] += 1
        bucket["correct"] += int(g == p)
    for bucket in by_category.values():
        bucket["accuracy"] = round(bucket["correct"] / bucket["n"], 3)
    return {
        "n": len(rows),
        "accuracy": round(correct / len(rows), 4) if rows else 0.0,
        "per_label": per_label,
        "by_category": by_category,
        "top_confusions": sorted(confusion.items(), key=lambda kv: -kv[1])[:15],
        "confusion_matrix": confusion,
    }


def save_run(label: str, payload: dict[str, Any]) -> Path:
    RUNS.mkdir(exist_ok=True)
    path = RUNS / f"{label}.json"
    if path.exists():
        raise SystemExit(f"run label {label!r} already exists at {path}; a changed run is a new label")
    path.write_text(json.dumps(payload, indent=1) + "\n")
    return path


def markdown_table(results: dict[str, dict[str, Any]]) -> str:
    lines = ["| variant | val | dev_paraphrase | suite |", "| --- | --- | --- | --- |"]
    for variant, sets in results.items():
        lines.append(
            f"| {variant} | {sets['val']['accuracy']:.3f} | {sets['dev_paraphrase']['accuracy']:.3f} | {sets['suite']['accuracy']:.3f} |"
        )
    return "\n".join(lines)
