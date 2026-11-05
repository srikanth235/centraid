"""Stage a training job: the trainer and the data one GCP Spot VM needs (train/vm/).

    python bundle.py build <job> --train train.jsonl.zst --val val.jsonl.zst [--test test.jsonl.zst] [--arm A|B|C] ...

The records are a data version's (`cargo run -p centraid-datagen -- build --version vN`; datagen.py). The VM trains and nothing else:
export (to_gguf.py) and scoring (crates/assist-eval) run elsewhere, on the checkpoint that train/vm/ leaves in the bucket.

Staging: $BUNDLE_STAGE (default ${TMPDIR:-/tmp}/centraid-bundles)/<job>/data. data/ is flat: `bundle.dat` (a gzip tar of train/{train,arms,datagen}.py
and data/ holding the records) and `job.json`. A build only stages: train/vm/launch.sh uploads.

Trainer flags: job.json `train_args` carries --bs, --lr, --max-len, --embed and --val-n and, only when given, --arm, --checkpoints,
--train-eval-n, --pair-batches / --no-pair-batches, --ema, --epochs, --warmup, --min-lr, --lora, --dpo and its flags, --save-every, --resume,
--data-version. A flag not given is not in the job: train.py's defaults apply (marks at 25 / 50 / 75 / 100 %, pair batching on).
--data-version TAG names the data version the run trains on: metadata only, it reaches train_meta.json and the model card.

Continuation (`--continue-from gs://.../ckpt`, e.g. an RFT or DPO step on the soup): one flag for the continuation defaults, init from that
checkpoint (job.json `init`, as --init-ckpt), 1 epoch, lr 4e-6 decaying to --min-lr 0.05, --warmup 0.02, --ema 0.999. A flag given
explicitly wins over the preset's value (give --continue-from or --init-ckpt, not both). DPO (`--dpo PAIRS.jsonl[.zst|.gz] --dpo-beta B
--dpo-sft S`): the pair file is staged as data/dpo.jsonl[.zst|.gz] and train.py runs the DPO loss (see its docstring); --train is still
required (run_job.sh passes job.json `train` to the trainer unconditionally), and train.py only scores it (the original-data drift
sample), never trains on it.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import arms  # noqa: E402
STAGE = Path(os.environ.get("BUNDLE_STAGE") or Path(os.environ.get("TMPDIR") or "/tmp") / "centraid-bundles")
TRAIN_FILES = ["train.py", "arms.py", "datagen.py"]

CONTINUE = {"lr": 4e-6, "min_lr": 0.05, "warmup": 0.02, "ema": 0.999, "epochs": 1}  # --continue-from's defaults
LR = 2e-5                                                                           # --lr without --continue-from or --arm


def resolve(a) -> None:
    """Fill the flags the user left out (they parse as None): --continue-from sets init, 1 epoch, lr 4e-6, min-lr 0.05, warmup 0.02 and ema
    0.999; without it only --lr has a value of its own (2e-5 unless --arm names its own, then train.py's; the others stay unset and
    train.py's defaults apply). An explicit flag wins. Idempotent."""
    if a.continue_from:
        if a.init_ckpt and a.init_ckpt != a.continue_from:
            sys.exit("--continue-from %s and --init-ckpt %s name two starting points: give one" % (a.continue_from, a.init_ckpt))
        a.init_ckpt = a.continue_from
        for k, v in CONTINUE.items():
            if getattr(a, k) is None:
                setattr(a, k, v)
    if a.lr is None and not a.arm:
        a.lr = LR


def dpo_args(a):
    """train.py's --dpo (the file as staged inside the bundle), --dpo-beta and --dpo-sft, passed through only when given."""
    if not a.dpo:
        return []
    return ["--dpo", "data/dpo" + "".join(Path(a.dpo).suffixes)] + sum(
        ([flag, str(v)] for flag, v in (("--dpo-beta", a.dpo_beta), ("--dpo-sft", a.dpo_sft)) if v is not None), [])


def resume_args(a):
    """train.py's --save-every / --resume, passed through only when given (no flag: no resume checkpoints)."""
    return (["--save-every", str(a.save_every)] if a.save_every else []) + (["--resume"] if a.resume else [])


def train_args(a):
    """The trainer flags the staged job carries (job.json `train_args`; run_job.sh adds --model/--train/--out/--hours, --epochs and
    --save-every). Optional flags are there only when given."""
    resolve(a)
    out = ["--bs", str(a.bs)] + (["--lr", str(a.lr)] if a.lr is not None else []) + ["--max-len", str(a.max_len), "--embed", a.embed,
                                                                                        "--val-n", str(a.val_n)]
    out += (["--arm", a.arm] if a.arm else []) + (["--lora", str(a.lora)] if a.lora else [])
    out += (["--max-steps", str(a.max_steps)] if a.max_steps else [])
    out += (["--warmup", str(a.warmup)] if a.warmup is not None else []) + (["--min-lr", str(a.min_lr)] if a.min_lr is not None else [])
    for flag, val in (("--checkpoints", a.checkpoints), ("--train-eval-n", a.train_eval_n)):
        if val is not None:
            out += [flag, str(val)]
    if a.pair_batches is not None:  # a tri-state: not given = train.py's default (on)
        out.append("--pair-batches" if a.pair_batches else "--no-pair-batches")
    out += (["--ema", str(a.ema)] if a.ema else []) + (["--no-grad-ckpt"] if a.no_grad_ckpt else [])
    out += (["--epochs", str(a.epochs)] if a.epochs is not None else []) + dpo_args(a) + resume_args(a)
    return out + (["--data-version", a.data_version] if a.data_version else [])


def data_version(text: str) -> str:
    """--data-version: a data tag of the private dataset repository (`data-v7`; artefacts.py), nothing else."""
    if not re.fullmatch(r"data-v[0-9]+", text):
        raise argparse.ArgumentTypeError("%r is not a data version (data-vN)" % text)
    return text


def build(a):
    resolve(a)
    job_dir = STAGE / a.job
    shutil.rmtree(job_dir, ignore_errors=True)
    ds, tree = job_dir / "data", job_dir / "tree"
    for d in (ds, tree / "train", tree / "data"):
        d.mkdir(parents=True)
    for f in TRAIN_FILES:
        shutil.copy(HERE / f, tree / "train" / f)
    model = arms.ARMS[a.arm].base if a.arm else a.model  # train.py refuses an --arm whose base is not --model
    job = {"model": model, "init": a.init_ckpt, "hours": a.hours, "transformers": a.transformers,
           "train": "data/train" + "".join(Path(a.train).suffixes), "val": None,
           "train_args": train_args(a)}
    shutil.copy(a.train, tree / job["train"])
    if a.val:
        job["val"] = "data/val" + "".join(Path(a.val).suffixes)
        shutil.copy(a.val, tree / job["val"])
    if a.dpo:  # the pair file, beside train; train_args names it (`--dpo data/dpo.jsonl[.zst|.gz]`)
        shutil.copy(a.dpo, tree / "data" / ("dpo" + "".join(Path(a.dpo).suffixes)))
    if a.test:  # the trainer opens it only for the last eval (run_job.sh passes --test)
        job["test"] = "data/test" + "".join(Path(a.test).suffixes)
        shutil.copy(a.test, tree / job["test"])
    with tarfile.open(ds / "bundle.dat", "w:gz") as tf:
        for p in sorted(tree.iterdir()):
            tf.add(p, arcname=p.name)
    shutil.rmtree(tree)
    (ds / "job.json").write_text(json.dumps(job, indent=1))
    size = sum(f.stat().st_size for f in ds.rglob("*") if f.is_file())
    print("staged %s (%.1f MB): %s" % (ds, size / 1e6, ", ".join("%s %.1f MB" % (f.name, f.stat().st_size / 1e6)
                                                                  for f in sorted(ds.iterdir()))))
    print(json.dumps(job, indent=1))
    print("\nnext: JOB=%s BUCKET=<bucket> STAGE_DIR=%s train/vm/probe.sh (measure first), then train/vm/launch.sh" % (a.job, job_dir))


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["build"])
    ap.add_argument("job")
    ap.add_argument("--train", required=True)
    ap.add_argument("--val")
    ap.add_argument("--test", help="test file staged for train.py --test (scored at the last eval only)")
    ap.add_argument("--arm", choices=("A", "B", "C"), help="train.py --arm (arms.py): the base, the method and the default lr; "
                    "replaces --model")
    ap.add_argument("--pair-batches", action=argparse.BooleanOptionalAction, default=None,
                    help="train.py --pair-batches / --no-pair-batches (minimal pairs share an optimizer step; default on)")
    ap.add_argument("--checkpoints", help="train.py --checkpoints (fractions of the steps at which a mark is evaluated and saved; "
                    "default 0.25,0.5,0.75,1.0)")
    ap.add_argument("--train-eval-n", type=int, help="train.py --train-eval-n (default 300)")
    ap.add_argument("--ema", type=float, metavar="D", help="train.py --ema D (weight EMA saved beside every mark as "
                    "ckpt-NNN-ema; e.g. 0.999; passed only when given; 0 = none)")
    ap.add_argument("--epochs", type=int, help="train.py --epochs N (passed only when given, else run_job.sh's per-launch epochs "
                    "apply; --continue-from sets 1)")
    ap.add_argument("--continue-from", metavar="GS_CKPT", help="a continuation in one flag: --init-ckpt GS_CKPT, --epochs 1, --lr 4e-6 "
                    "decaying to --min-lr 0.05, --warmup 0.02, --ema 0.999; each explicit flag wins over the preset")
    ap.add_argument("--dpo", metavar="PAIRS", help="train.py --dpo: DPO on a JSONL of {id, chosen, rejected} datagen records, "
                    "staged into the bundle; needs --train too (scored for drift, never trained on)")
    ap.add_argument("--dpo-beta", type=float, help="train.py --dpo-beta (default 0.1; passed only when given)")
    ap.add_argument("--dpo-sft", type=float, help="train.py --dpo-sft (weight of the SFT term on the chosen record, default 0.2; "
                    "passed only when given)")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="train.py --no-grad-ckpt (more memory, faster)")
    ap.add_argument("--save-every", type=int, default=0, help="train.py --save-every N (resume checkpoint every N steps; "
                    "default 0 = none)")
    ap.add_argument("--resume", action="store_true", help="train.py --resume (continue from the newest resume "
                    "checkpoint in the run's out folder, else start fresh)")
    ap.add_argument("--data-version", type=data_version, metavar="TAG", help="the data version (data-vN) --train and --val belong to: "
                    "passed to train.py as metadata only, so train_meta.json and the model card name it")
    ap.add_argument("--model", default=arms.TOKENIZER)
    ap.add_argument("--init-ckpt", help="gs:// checkpoint directory the training starts from instead of --model (job.json `init`; "
                    "run_job.sh pulls it): a continuation run")
    ap.add_argument("--hours", type=float, default=8.0, help="training wall-clock budget")
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, help="learning rate (default 2e-5; 4e-6 with --continue-from; the arm's with --arm)")
    ap.add_argument("--warmup", type=float, help="train.py --warmup (fraction of steps; passed only when given)")
    ap.add_argument("--min-lr", type=float, help="train.py --min-lr (final lr as a fraction of --lr; passed only when given)")
    ap.add_argument("--max-len", type=int, default=8192)
    ap.add_argument("--embed", default="freeze", choices=["freeze", "train"])
    ap.add_argument("--val-n", type=int, default=400)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank (0 = full fine-tune)")
    ap.add_argument("--transformers", default="5.17.0")
    ap.add_argument("--dry", action="store_true", help="accepted and ignored: a build only stages, nothing is uploaded")
    return ap


def main():
    a = parser().parse_args()
    resolve(a)
    if a.continue_from and not a.continue_from.startswith("gs://"):
        sys.exit("--continue-from %s: a gs:// checkpoint directory (run_job.sh pulls it)" % a.continue_from)
    if a.dpo and not Path(a.dpo).is_file():
        sys.exit("--dpo %s is not a file" % a.dpo)
    build(a)


if __name__ == "__main__":
    main()
