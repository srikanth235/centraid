"""Model soup: the uniform weight average of fine-tuned checkpoints of one base model (#1044).

    python train/soup.py IN_DIR [IN_DIR ...] OUT_DIR

Each IN_DIR is a checkpoint folder as train.py saves it (model.safetensors, config, tokenizer). The tensors are summed in fp32 and divided
by the number of inputs, then cast back to each tensor's dtype; every other file is copied from the last input (the configs must agree).
A weighted soup repeats an input: `soup.py A A B B B OUT` is 40 % A, 60 % B. Run it on CPU; 0.8B needs about 4 GB of RAM.

What it bought on val (655 sessions, nt12): i2's checkpoints 75 % + 100 % 502 (ckpt-100 alone 489); with the r3 average (491) 534; with
r2 ckpt-100 as a third 537. Averaging only helps checkpoints fine-tuned from the same base; it is checked by scoring, never assumed.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file


def soup(ins: list[str], out: str) -> int:
    acc, dtypes = None, None
    for d in ins:
        t = load_file(os.path.join(d, "model.safetensors"))
        if acc is None:
            acc = {k: v.float().clone() for k, v in t.items()}
            dtypes = {k: v.dtype for k, v in t.items()}
            continue
        if t.keys() != acc.keys():
            raise SystemExit("%s holds other tensors than %s: not the same model" % (d, ins[0]))
        for k, v in t.items():
            if v.shape != acc[k].shape:
                raise SystemExit("%s: %s is %s, not %s" % (d, k, tuple(v.shape), tuple(acc[k].shape)))
            acc[k] += v.float()
    Path(out).mkdir(parents=True, exist_ok=True)
    for f in Path(ins[-1]).iterdir():
        if f.is_file() and f.name != "model.safetensors":
            shutil.copy(f, Path(out) / f.name)
    save_file({k: (v / len(ins)).to(dtypes[k]).contiguous() for k, v in acc.items()}, os.path.join(out, "model.safetensors"),
              metadata={"format": "pt"})
    return len(acc)


def main(argv: list[str]) -> None:
    if len(argv) < 3:
        raise SystemExit(__doc__)
    *ins, out = argv[1:]
    n = soup(ins, out)
    print("averaged %d checkpoints -> %s (%d tensors)" % (len(ins), out, n))


if __name__ == "__main__":
    main(sys.argv)
