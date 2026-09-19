"""Train the joint operation + slot model on CPU.

    .venv-joint/bin/python joint/train_joint.py --label j-01 --epochs 3

Two threads by default: other lanes share the four cores. One run of three
epochs over ~7.8k rows takes roughly 20 minutes.

The checkpoint goes to ``joint/artifacts/<label>/`` (gitignored); the metrics
of the run are written next to it *and* to ``runs/<label>.json``, which is
append-only — an existing label is refused, never overwritten.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "selector"))

import model as M  # noqa: E402


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def predict_rows(net: M.JointModel, tokenizer, rows: list[dict], batch_size: int = 64) -> list[dict]:
    """Operation, slots and enums for every row, as the runtime would read them."""
    net.eval()
    out: list[dict] = []
    with torch.no_grad():
        for start in range(0, len(rows), batch_size):
            chunk = rows[start : start + batch_size]
            encoded, offsets, request_mask = M.encode_rows(chunk, tokenizer, with_targets=False)
            operation_logits, tag_logits, enum_logits = net(**encoded)
            probabilities = torch.softmax(operation_logits, dim=-1)
            order = torch.argsort(probabilities, dim=-1, descending=True)
            tags = tag_logits.argmax(dim=-1)
            for index, row in enumerate(chunk):
                positions = [i for i in range(request_mask.shape[1]) if bool(request_mask[index, i])]
                slots = M.decode_spans(str(row["request"]), tags[index].tolist(), offsets[index].tolist(), positions)
                enums: dict[str, str] = {}
                for slot in M.ENUM_SLOTS:
                    begin, finish = M.ENUM_OFFSETS[slot]
                    choice = int(enum_logits[index, begin:finish].argmax())
                    values = M.ENUM_VALUES[slot]
                    if choice < len(values):
                        enums[slot] = values[choice]
                top = [(M.LABELS[int(i)], round(float(probabilities[index, int(i)]), 4)) for i in order[index, :3]]
                out.append(
                    {
                        "operation": top[0][0],
                        "top3": top,
                        "margin": round(top[0][1] - top[1][1], 4),
                        "slots": slots,
                        "enums": enums,
                    }
                )
    return out


def evaluate(net: M.JointModel, tokenizer, rows: list[dict]) -> dict:
    """Operation accuracy, top-3, and slot metrics against the row's annotation."""
    predictions = predict_rows(net, tokenizer, rows)
    correct = top3 = 0
    slot_exact = slot_rows = 0
    span_hits = span_total = span_predicted = 0
    enum_hits = enum_total = 0
    by_kind: dict[str, dict[str, float]] = {}
    for row, prediction in zip(rows, predictions):
        gold_label = str(row["label"])
        hit = prediction["operation"] == gold_label
        correct += hit
        top3 += any(name == gold_label for name, _ in prediction["top3"])
        bucket = by_kind.setdefault(str(row.get("kind") or row.get("category") or "all"), {"n": 0, "correct": 0})
        bucket["n"] += 1
        bucket["correct"] += int(hit)

        gold_spans = {s["slot"]: s["text"].strip().lower() for s in row.get("spans", [])}
        predicted = {k: v.strip().lower() for k, v in prediction["slots"].items()}
        keep = set(M.A.PARAMS.get(gold_label, {}))
        predicted_relevant = {k: v for k, v in predicted.items() if k in keep}
        span_total += len(gold_spans)
        span_predicted += len(predicted_relevant)
        span_hits += sum(1 for k, v in gold_spans.items() if predicted_relevant.get(k) == v)
        gold_enums = {k: v for k, v in (row.get("enums") or {}).items() if k in keep}
        predicted_enums = {k: v for k, v in prediction["enums"].items() if k in keep}
        enum_total += len(gold_enums)
        enum_hits += sum(1 for k, v in gold_enums.items() if predicted_enums.get(k) == v)
        slot_rows += 1
        slot_exact += int(predicted_relevant == gold_spans)

    for bucket in by_kind.values():
        bucket["accuracy"] = round(bucket["correct"] / bucket["n"], 3)
    return {
        "n": len(rows),
        "operation_top1": round(correct / len(rows), 4),
        "operation_top3": round(top3 / len(rows), 4),
        "slot_set_exact": round(slot_exact / slot_rows, 4) if slot_rows else 0.0,
        "span_recall": round(span_hits / span_total, 4) if span_total else 0.0,
        "span_precision": round(span_hits / span_predicted, 4) if span_predicted else 0.0,
        "enum_accuracy": round(enum_hits / enum_total, 4) if enum_total else 0.0,
        "by_kind": by_kind,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--lr", type=float, default=4e-5)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=13)
    args = parser.parse_args()

    run_path = ROOT / "runs" / f"{args.label}.json"
    if run_path.exists():
        raise SystemExit(f"run label {args.label!r} already exists at {run_path}")

    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    random.seed(args.seed)

    train = load(HERE / "train.jsonl")
    val = load(HERE / "val.jsonl")
    dev_path = HERE / "dev_joint.jsonl"
    dev = load(dev_path) if dev_path.exists() else []
    suite_path = HERE / "suite_joint.jsonl"
    suite = load(suite_path) if suite_path.exists() else []

    tokenizer = M.build_tokenizer()
    net = M.JointModel(vocab_size=len(tokenizer))
    optimiser = torch.optim.AdamW(net.parameters(), lr=args.lr)
    steps = args.epochs * ((len(train) + args.batch_size - 1) // args.batch_size)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimiser, max_lr=args.lr, total_steps=steps, pct_start=0.1)

    started = time.time()
    history = []
    best = -1.0
    directory = HERE / "artifacts" / args.label
    directory.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        net.train()
        order = list(range(len(train)))
        random.shuffle(order)
        total = 0.0
        batches = 0
        for start in range(0, len(order), args.batch_size):
            rows = [train[i] for i in order[start : start + args.batch_size]]
            batch, _offsets, _mask = M.encode_rows(rows, tokenizer)
            outputs = net(**batch.encoded)
            loss = M.loss_of(outputs, batch)
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()
            schedule.step()
            total += float(loss)
            batches += 1
            if batches % 50 == 0:
                print(f"  epoch {epoch + 1} step {batches}/{len(order) // args.batch_size} loss {total / batches:.4f}", flush=True)
        measured = evaluate(net, tokenizer, val)
        history.append({"epoch": epoch + 1, "train_loss": round(total / max(1, batches), 4), "val": measured})
        print(
            f"epoch {epoch + 1}: loss {total / max(1, batches):.4f} "
            f"val op {measured['operation_top1']:.3f} slots {measured['slot_set_exact']:.3f}",
            flush=True,
        )
        if measured["operation_top1"] + measured["slot_set_exact"] > best:
            best = measured["operation_top1"] + measured["slot_set_exact"]
            torch.save(net.state_dict(), directory / "model.pt")
            tokenizer.save_pretrained(directory)
            (directory / "config.json").write_text(json.dumps(M.config_blob(), indent=1) + "\n")

    net.load_state_dict(torch.load(directory / "model.pt"))
    results = {"val": evaluate(net, tokenizer, val)}
    if dev:
        results["dev_joint"] = evaluate(net, tokenizer, dev)
    if suite:
        results["suite_turns"] = evaluate(net, tokenizer, suite)

    payload = {
        "lane": "joint",
        "label": args.label,
        "encoder": M.ENCODER,
        "parameters": sum(p.numel() for p in net.parameters()),
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "seed": args.seed,
        "train_rows": len(train),
        "wall_clock_seconds": round(time.time() - started, 1),
        "history": history,
        "results": results,
    }
    (directory / "metrics.json").write_text(json.dumps(payload, indent=1) + "\n")
    (ROOT / "runs").mkdir(exist_ok=True)
    run_path.write_text(json.dumps(payload, indent=1) + "\n")
    print(json.dumps(results, indent=1))
    print(f"wrote {run_path} and {directory / 'metrics.json'}")


if __name__ == "__main__":
    main()
