"""int8 dynamic quantisation: size on disk and per-turn latency under load.

    ../.venv/bin/python quantise.py --model ../runs/enc-minilm
"""
from __future__ import annotations

import argparse
import os
import time

import torch
from torch import nn

from features import encode
from infer_encoder import load, predict
from task import gold_rows


def size_mb(model, path):
    torch.save(model.state_dict(), path)
    return os.path.getsize(path) / 1e6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--threads", type=int, default=2)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    tok, model, vocabs = load(args.model)

    fp32 = size_mb(model, "/tmp/enc-fp32.pt")
    from torch.ao.quantization import float_qparams_weight_only_qconfig, \
        default_dynamic_qconfig
    q = torch.ao.quantization.quantize_dynamic(
        model,
        {nn.Linear: default_dynamic_qconfig,
         nn.Embedding: float_qparams_weight_only_qconfig},
        dtype=torch.qint8)
    int8 = size_mb(q, "/tmp/enc-int8.pt")
    print("fp32 %.1f MB   int8 %.1f MB" % (fp32, int8))
    print("params %.2fM" % (sum(p.numel() for p in model.parameters()) / 1e6))

    rows = gold_rows()
    for name, m in (("fp32", model), ("int8", q)):
        lat = []
        for row in rows:
            text = "NONE ||| %s" % row["request"]
            t0 = time.perf_counter()
            predict(tok, m, vocabs, text, "NONE")
            lat.append((time.perf_counter() - t0) * 1000)
        lat.sort()
        print("%s  n=%d  p50 %.1f ms  p95 %.1f ms  mean %.1f ms"
              % (name, len(lat), lat[len(lat) // 2],
                 lat[int(0.95 * len(lat))], sum(lat) / len(lat)))
    print("load average: %s" % (os.getloadavg(),))


if __name__ == "__main__":
    main()
