"""Are train, val and test one distribution? Three layers for every pair of sets, plus a floor per set.

    HF_HUB_OFFLINE=1 $PY authored/dist.py --train 'OUT/*.gold.jsonl' A.jsonl B.jsonl [C.jsonl ...] \
        [--json F] [--md F] [--hide B]

Inputs are session files in the gold format (world, turns: user / gold / ref / tags). Train files drop
the val worlds (split.drop_val). The floor of a set is its sessions split in two halves by alternating
index: the distance a set has from itself.
  shape    per feature, total variation distance in points (half the L1 between normalised histograms):
           session length, first gold type, tools, act verb, answer filter shape, calls per turn,
           words per message, turn index. Pass per feature: observed <= the 95th percentile of 200 seeded
           permutation splits (whole sessions pooled and re-split at the original sizes, so within-session
           correlation is kept). Pair verdict: at most one failing feature, with observed/threshold < 1.25
           (8 tests at 95% put about one spurious fail across the pairs). The halves floor is reference only.
  support  (train vs each eval set) share of eval turns whose every scenario cell has >= 3 train uses in
           >= 2 train worlds. Pass: >= 95%. Cells: build.py's `replay` is absent in eval sets, so cells are
           the replay-free key (tool, verb or op, kind, reference mode) of coverage.call_kinds / selectors,
           applied to every set alike; calls with no `kind` arg count under kind "?" in all sets.
  probes   names-masked text AUC and gold-side AUC (each call's tool, verb/op, kind, arg keys, where/when
           with literals replaced), 6-seed mean +- sd, bge-small + logistic regression. Soft line 0.60:
           reported, never an exit status.
--hide B: the printed and markdown output show only pass/fail per layer for pairs and the floor involving
B; the --json file keeps every number. Exit 1 if a shape or support check fails.
"""
from __future__ import annotations

import argparse
import collections
import glob
import itertools
import json
import random
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import coverage as COV  # noqa: E402
import gate  # noqa: E402
import split  # noqa: E402

PERMS, RATIO_MAX, SUPPORT_MIN, SOFT_AUC, MIN_USES, MIN_WORLDS, CAP = 200, 1.25, 95.0, 0.60, 3, 2, 3000


def load(paths) -> list[dict]:
    return [json.loads(l) for p in paths for l in open(p) if l.strip()]


# --- layer a: shape ---------------------------------------------------------------------------


def shape_hists(ses: list[dict]) -> dict[str, collections.Counter]:
    H = collections.defaultdict(collections.Counter)
    for s in ses:
        H["session length"][min(len(s["turns"]), 7)] += 1
        for i, t in enumerate(s["turns"]):
            H["first gold type"][t["gold"][0]["type"]] += 1
            H["calls per turn"][min(len(t["ref"]), 3)] += 1
            H["words per message"][min(len(t["user"].split()) // 4, 5)] += 1
            H["turn index"][min(i + 1, 6)] += 1
            for c in t["ref"]:
                a = c.get("args") or {}
                H["tools"][c["tool"]] += 1
                if c["tool"] == "act":
                    H["act verb"][a.get("verb", "?")] += 1
                if c["tool"] == "answer":
                    H["answer filter"]["+".join(k for k in ("where", "when", "linked_to") if a.get(k)) or "none"] += 1
    return H


def tvd(p: collections.Counter, q: collections.Counter) -> float:
    ks, np_, nq = set(p) | set(q), max(sum(p.values()), 1), max(sum(q.values()), 1)
    return 50.0 * sum(abs(p[k] / np_ - q[k] / nq) for k in ks)


def shape_pair(a: dict, b: dict) -> dict[str, float]:
    return {f: tvd(a[f], b[f]) for f in a}


def shape_perm(A: list[dict], B: list[dict]) -> dict[str, dict]:
    """Per feature {obs, thr, ratio, pass}: observed TVD against the 95th percentile of PERMS random
    re-splits of the pooled sessions (A, B: per-session shape_hists)."""
    rng, out = np.random.default_rng(0), {}
    perms = [rng.permutation(len(A) + len(B)) for _ in range(PERMS)]
    for f in A[0]:
        keys = sorted({k for h in A + B for k in h[f]}, key=str)
        M = np.array([[h[f][k] for k in keys] for h in A + B], dtype=float)
        tot, na = M.sum(0), len(A)
        obs = 50.0 * np.abs(M[:na].sum(0) / max(M[:na].sum(), 1) - M[na:].sum(0) / max(M[na:].sum(), 1)).sum()
        sims = []
        for p in perms:
            ca = M[p[:na]].sum(0)
            cb = tot - ca
            sims.append(50.0 * np.abs(ca / max(ca.sum(), 1) - cb / max(cb.sum(), 1)).sum())
        thr = float(np.percentile(sims, 95))
        out[f] = {"obs": float(obs), "thr": thr, "ratio": float(obs / max(thr, 1e-9)), "pass": bool(obs <= thr)}
    return out


def shape_verdict(sh: dict) -> tuple[bool, int, str]:
    """(pair passes, failing features, worst feature by obs/thr)."""
    fails = [f for f, r in sh.items() if not r["pass"]]
    worst = max(sh, key=lambda f: sh[f]["ratio"])
    return len(fails) == 0 or (len(fails) == 1 and sh[fails[0]]["ratio"] < RATIO_MAX), len(fails), worst


# --- layer b: support -------------------------------------------------------------------------


class _NoWorld:
    def kind_of(self, ref):
        return "?"


def turn_cells(t: dict) -> set[tuple]:
    out = set()
    for c in t["ref"]:
        if c.get("bad"):
            continue
        a, tool = c.get("args") or {}, c["tool"]
        v = a.get("verb") or a.get("op") or "-"
        if tool not in ("act", "answer", "find", "search", "open", "compute"):
            out.add((tool, v, "-", "-"))
            continue
        sels = ["-"] if v == "create" else COV.selectors(c, t)
        out |= {(tool, v, k, s) for k in COV.call_kinds(c, _NoWorld(), None) for s in sels}
    return out


def uses_of(ses: list[dict]) -> dict[tuple, dict]:
    U = collections.defaultdict(lambda: {"n": 0, "worlds": set()})
    for s in ses:
        for t in s["turns"]:
            for c in turn_cells(t):
                U[c]["n"] += 1
                U[c]["worlds"].add(s["world"])
    return U


def supported(u: dict | None) -> bool:
    return bool(u) and u["n"] >= MIN_USES and len(u["worlds"]) >= MIN_WORLDS


def support(train_uses: dict, ev: list[dict]) -> tuple[float, list]:
    n = ok = 0
    ev_cells = collections.Counter()
    for s in ev:
        for t in s["turns"]:
            cs = turn_cells(t)
            n += 1
            ok += all(supported(train_uses.get(c)) for c in cs)
            ev_cells.update(cs)
    worst = sorted(ev_cells, key=lambda c: (train_uses[c]["n"] if c in train_uses else 0, -ev_cells[c]))[:20]
    return 100.0 * ok / max(n, 1), [(" · ".join(c), train_uses[c]["n"] if c in train_uses else 0,
                                     len(train_uses[c]["worlds"]) if c in train_uses else 0, ev_cells[c]) for c in worst]


# --- layer c: probes --------------------------------------------------------------------------


def lit(s: str) -> str:
    return re.sub(r"-?\d[\d.:/-]*", "N", re.sub(r'"[^"]*"', "STR", s))


def skeleton(x):
    if isinstance(x, dict):
        return "{" + ",".join(f"{k}:{k if k == 'unit' else skeleton(v)}" for k, v in sorted(x.items())) + "}"
    return "v"


def when_text(w) -> str:
    try:
        return skeleton(json.loads(w) if isinstance(w, str) else w)
    except (ValueError, TypeError):
        return "v"


def gold_text(t: dict) -> str:
    out = []
    for c in t["ref"]:
        a = c.get("args") or {}
        out.append(" ".join([c["tool"], a.get("verb") or a.get("op") or "-", str(a.get("kind") or "-"),
                             "keys=" + ",".join(sorted(a)),
                             "where=" + lit(a["where"]) if a.get("where") else "",
                             "when=" + when_text(a["when"]) if a.get("when") else ""]).strip())
    return " ; ".join(out)


def embed_set(ses: list[dict], mask, seed=0):
    """Whole sessions up to CAP turns -> (session parity per turn, masked-text matrix, gold-text matrix)."""
    ses = sorted(enumerate(ses), key=lambda x: random.Random(seed * 100003 + x[0]).random())
    par, texts, golds, n = [], [], [], 0
    for i, s in ses:
        if n >= CAP:
            break
        for t in s["turns"]:
            par.append(i % 2), texts.append(mask(t["user"].strip())), golds.append(gold_text(t))
        n += len(s["turns"])
    E = gate.embed(texts + golds)
    return np.array(par), E[:len(texts)], E[len(texts):]


# --- report -----------------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", required=True)
    ap.add_argument("sets", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--md")
    ap.add_argument("--hide")
    a = ap.parse_args()
    S = {"train": split.drop_val(load(sorted(glob.glob(a.train))))}
    S.update({Path(p).stem: load([p]) for p in a.sets})
    hide = Path(a.hide).stem if a.hide else None
    evs = list(S)[1:]
    H = {k: shape_hists(v) for k, v in S.items()}
    half = {k: (shape_hists(v[0::2]), shape_hists(v[1::2])) for k, v in S.items()}
    tu = uses_of(S["train"])
    mask = gate.masker()
    SV = {k: [shape_hists([x]) for x in v] for k, v in S.items()}
    emb = {k: embed_set(v, mask) for k, v in S.items()}

    def probe(x, y, which):
        return gate.auc_stats(x[which], y[which], seeds=6)

    R = {"pairs": {}, "floors": {}, "cells": {}}
    for x, y in itertools.combinations(S, 2):
        sh = shape_perm(SV[x], SV[y])
        ok, nf, w = shape_verdict(sh)
        r = {"shape_fails": nf, "shape_worst": w, "shape_worst_ratio": sh[w]["ratio"], "shape": sh, "shape_pass": ok}
        if x == "train":
            r["support"], R["cells"][y] = support(tu, S[y])
            r["support_pass"] = r["support"] >= SUPPORT_MIN
        for name, col in (("text", 1), ("gold", 2)):
            r[name + "_auc"], r[name + "_sd"] = probe(emb[x], emb[y], col)
        R["pairs"][f"{x}/{y}"] = r
    for k, (p, q) in half.items():
        sh = shape_pair(p, q)
        par = emb[k][0]
        f = {"shape_max": max(sh.values()), "shape_worst": max(sh, key=sh.get), "shape": sh}
        for name, col in (("text", 1), ("gold", 2)):
            f[name + "_auc"], f[name + "_sd"] = gate.auc_stats(emb[k][col][par == 0], emb[k][col][par == 1], seeds=6)
        R["floors"][k] = f
    if a.json:
        json.dump(R, open(a.json, "w"), indent=1, ensure_ascii=False)

    hid = lambda key: hide is not None and hide in key.split("/")
    verdict = lambda ok: "pass" if ok else "FAIL"
    soft = lambda v: "<=.60" if v <= SOFT_AUC else ">.60"
    L = [f"# Distribution: " + ", ".join(f"{k} {len(v)} sessions / {sum(len(s['turns']) for s in v)} turns" for k, v in S.items()), "",
         "| pair | shape: failing features / 8 | worst feature (obs/thr, TVD pts) | support % | text AUC | gold AUC |", "|---|---|---|---|---|---|"]
    for key, r in R["pairs"].items():
        if hid(key):
            L.append(f"| {key} | {verdict(r['shape_pass'])} | - | {verdict(r['support_pass']) if 'support' in r else '-'} | "
                     f"{soft(r['text_auc'])} | {soft(r['gold_auc'])} |")
            continue
        w = r["shape"][r["shape_worst"]]
        L.append(f"| {key} | {r['shape_fails']} ({verdict(r['shape_pass'])}) | {r['shape_worst']} ({w['ratio']:.2f}, {w['obs']:.1f} vs {w['thr']:.1f}) | "
                 + (f"{r['support']:.1f} ({verdict(r['support_pass'])})" if "support" in r else "-")
                 + f" | {r['text_auc']:.3f}±{r['text_sd']:.3f} | {r['gold_auc']:.3f}±{r['gold_sd']:.3f} |")
    L += ["", "Floors (a set's sessions in two alternating halves; reference only, not in the verdict):", "", "| set | shape max TVD | worst | text AUC | gold AUC |", "|---|---|---|---|---|"]
    for k, f in R["floors"].items():
        L.append(f"| {k} | " + (" | ".join(["-"] * 4) if hid(k) else
                 f"{f['shape_max']:.1f} | {f['shape_worst']} | {f['text_auc']:.3f}±{f['text_sd']:.3f} | {f['gold_auc']:.3f}±{f['gold_sd']:.3f} |"))
    L += ["", f"Pass: shape = at most one feature over its permutation threshold (95th pct of {PERMS} session re-splits) with obs/thr < {RATIO_MAX}; "
          f"8 tests at 95% give about one spurious fail across all pairs. Support >= {SUPPORT_MIN:g}% (cell >= {MIN_USES} train uses in >= {MIN_WORLDS} worlds); "
          f"probes soft line {SOFT_AUC} (reported, not a gate). Cells: replay-free key (tool, verb/op, kind, reference mode)."]
    print("\n".join(L))
    if a.md:
        M = list(L) + ["", "## Shape: observed TVD / permutation threshold per feature (pts); floors are halves TVD", "", "| feature | " + " | ".join(f"{k} obs / thr" for k in R["pairs"] if not hid(k)) + " | " +
                       " | ".join(f"floor {k}" for k in S if not hid(k)) + " |", "|---|" + "---|" * (len([k for k in R['pairs'] if not hid(k)]) + len([k for k in S if not hid(k)]))]
        for f in H["train"]:
            M.append(f"| {f} | " + " | ".join(f"{r['shape'][f]['obs']:.1f} / {r['shape'][f]['thr']:.1f}{'' if r['shape'][f]['pass'] else ' FAIL'}" for k, r in R["pairs"].items() if not hid(k)) + " | "
                     + " | ".join(f"{R['floors'][k]['shape'][f]:.1f}" for k in S if not hid(k)) + " |")
        for y, cs in R["cells"].items():
            if not hid(y):
                M += ["", f"## Least-supported {y} cells (train uses, train worlds, {y} turns using it)", ""]
                M += [f"- {c}: {n} uses, {w} worlds, {m} turns" for c, n, w, m in cs]
        Path(a.md).write_text("\n".join(M) + "\n")
    sys.exit(0 if all(r["shape_pass"] and r.get("support_pass", True) for r in R["pairs"].values()) else 1)


if __name__ == "__main__":
    main()
