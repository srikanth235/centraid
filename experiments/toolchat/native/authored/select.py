"""Choose which authored sessions to train on so every tag family matches val's mix.

    python3 authored/select.py --gold '/tmp/authored-T*/T*.gold.jsonl' --out authored/selected.json

Only train-world sessions are candidates (authored/split.py drops the val worlds from --gold).
Greedy: drop the session whose removal most reduces the worst family's total variation distance to
val (gapreport.py's shift score), never letting a tag fall under the gap-report floors (share of at
least 0.6x val, 35 uses). Stops when every family is under the target or nothing helps.
The training set is every train gold session not listed in `drop`; gapreport.py takes the same file
with --drop. Shares are measured against val only (eval/sets/val.jsonl), as everywhere else.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

import split
from gapreport import FAMILIES, HERE, VAL, derive_tags, load, world_rows

TARGET, FLOOR_RATIO, FLOOR_USES = 0.04, 0.6, 35


def counts(sessions: list[dict], wdir, cache: dict) -> tuple[list[dict], list[str]]:
    per, tags = [], set()
    for s in sessions:
        rows = world_rows(wdir / f"{s['world']}.json", cache)
        c: dict[str, int] = {}
        for i, t in enumerate(s["turns"], 1):
            for tag in derive_tags(t, i, rows, s):
                c[tag] = c.get(tag, 0) + 1
        per.append({"id": s["id"], "world": s["world"], "turns": len(s["turns"]), "c": c})
        tags |= set(c)
    return per, sorted(tags)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cache: dict = {}
    auth, tags = counts(split.drop_val(load(a.gold)), HERE / "worlds", cache)
    val, _ = counts(load(str(VAL)), HERE / "worlds", cache)
    tags = sorted(set(tags) | {t for d in val for t in d["c"]})
    K, N = len(tags), len(auth)
    idx = {t: k for k, t in enumerate(tags)}
    S = np.zeros((N, K))
    for i, s in enumerate(auth):
        for t, n in s["c"].items():
            S[i, idx[t]] = n
    tt = np.array([s["turns"] for s in auth], float)
    dcount = np.zeros(K)
    for d in val:
        for t, n in d["c"].items():
            dcount[idx[t]] += n
    D = dcount / sum(d["turns"] for d in val)
    judged = dcount >= 2
    fams = sorted({t.split(":")[0] for t in tags})
    F = np.array([[t.split(":")[0] == f for f in fams] for t in tags], float)  # K x F
    keep = np.ones(N, bool)
    C, T = S.sum(0), tt.sum()

    def tv(c, t):
        return 0.5 * (np.abs(c / t - D) @ F) if c.ndim == 1 else 0.5 * (np.abs(c / t[:, None] - D) @ F)

    before = dict(zip(fams, tv(C, T).round(4)))
    drops = []
    while True:
        cur = tv(C, T)
        if cur.max() <= TARGET:
            break
        C2, T2 = C[None, :] - S, T - tt
        ok = keep.copy()
        hit = judged & (S > 0)  # a floor only binds on tags the removal actually lowers
        ok &= ~((hit & ((C2 / T2[:, None]) < FLOOR_RATIO * D)).any(1))
        ok &= ~((hit & (C2 < FLOOR_USES)).any(1))
        if not ok.any():
            break
        tvs = tv(C2, T2)
        score = tvs.max(1) + 0.05 * tvs.sum(1)
        score[~ok] = np.inf
        i = int(score.argmin())
        if score[i] >= cur.max() + 0.05 * cur.sum():
            break
        keep[i] = False
        C, T = C2[i], T2[i]
        drops.append(auth[i]["id"])
    after = dict(zip(fams, tv(C, T).round(4)))
    out = {"drop": drops, "kept_sessions": int(keep.sum()), "kept_turns": int(T), "target": TARGET,
           "shift_before": before, "shift_after": after}
    json.dump(out, open(a.out, "w"), indent=1)
    print(f"dropped {len(drops)} of {N} sessions; kept {int(keep.sum())} sessions, {int(T)} turns")
    for f in fams:
        print(f"  {f:11s} {before[f]:.3f} -> {after[f]:.3f}")


if __name__ == "__main__":
    main()
