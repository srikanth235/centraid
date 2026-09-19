"""LoRA fine-tune of Needle 3 on CPU, then export a runnable .cact.

Needle 3 is not a transformers model, so peft is not usable: the only trainer
that understands the architecture is the one shipped in `cactus-needle`
(JAX/flax, CQ-STE numerics matching the export). This wraps it so the run is
labelled, timed and reproducible, and holds out WHOLE TEMPLATES via a separate
val file rather than the trainer's random split.

    .venv/bin/python needle/train_lora.py --label r16e2 \
        --train needle/data/train.jsonl --rank 16 --epochs 2
"""

from __future__ import annotations

import argparse
import json
import os
import resource
import time
import types

os.environ.setdefault("NEEDLE_TELEMETRY", "0")
os.environ.setdefault("CACTUS_TELEMETRY", "0")
os.environ.setdefault("JAX_PLATFORMS", "cpu")

from needle.model import finetune  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--train", default="needle/data/train.jsonl")
    parser.add_argument("--checkpoint", default="needle/checkpoints/needle3.safetensors")
    parser.add_argument("--adapters-dir", default="needle/adapters")
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=float, default=32.0)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument("--max-len", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--no-build", action="store_true",
                        help="skip the .cact export")
    args = parser.parse_args()

    out_dir = os.path.join(args.adapters_dir, args.label)
    if os.path.exists(out_dir):
        raise SystemExit(f"label already exists: {out_dir} (labels are append-only)")
    os.makedirs(out_dir)

    adapter = os.path.join(out_dir, "adapter.safetensors")
    train_args = types.SimpleNamespace(
        checkpoint=args.checkpoint,
        jsonl_path=args.train,
        generate=0,
        lora_rank=args.rank,
        lora_alpha=args.alpha,
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        max_len=args.max_len,
        seed=args.seed,
        val_split=0.0,  # whole-template holdout lives in a separate val file
        checkpoint_dir=out_dir,
        out=adapter,
    )

    log: list[str] = []
    started = time.time()
    finetune.finetune_local(train_args, progress=log.append)
    train_seconds = time.time() - started

    built = None
    if not args.no_build:
        built = os.path.join(out_dir, "tuned.cact")
        build_args = types.SimpleNamespace(
            lora=adapter, checkpoint=args.checkpoint, out=built,
            platform=None, layers=None, upload=False)
        finetune.build_main(build_args)

    metrics = {
        "label": args.label,
        "train_file": args.train,
        "n_train": sum(1 for line in open(args.train) if line.strip()),
        "rank": args.rank,
        "alpha": args.alpha,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "max_len": args.max_len,
        "seed": args.seed,
        "train_seconds": round(train_seconds, 1),
        "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "adapter": adapter,
        "cact": built,
        "log": log,
    }
    with open(os.path.join(out_dir, "metrics.json"), "w") as sink:
        json.dump(metrics, sink, indent=2)
    print(json.dumps({k: v for k, v in metrics.items() if k != "log"}, indent=2))


if __name__ == "__main__":
    main()
