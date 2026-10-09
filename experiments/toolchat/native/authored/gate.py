"""The gate on the authored corpus: hygiene (near-duplicates), with the AUC against val as a diagnostic.

    HF_HUB_OFFLINE=1 $PY authored/gate.py OUT/*.gold.jsonl [--json F]

Authored side: the train worlds only (authored/split.py drops val worlds from the files given).
Diagnostic, never a pass/fail: names-masked AUC of train user messages against val user messages
(eval/sets/val.jsonl), 6-seed mean +- sd; the baseline is val against itself (two halves of its sessions).
Whether train, val and test are one distribution is judged by authored/dist.py (shape, support, probes).
Hygiene: no exact or near-duplicate (cos >= 0.95, 6+ words) of a val message or a test message in
train; test is read here for that pass/fail only, never for a number that shapes authoring.
Exit 1 on a hygiene failure only.
"""
from __future__ import annotations

import argparse
import glob
import json
import random
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import split  # noqa: E402

SETS = HERE.parent / "eval" / "sets"
DUP_COS, MIN_WORDS = 0.95, 6


def user_texts(path: Path, train_only: bool = False) -> list[str]:
    """User messages of a sessions file; `train_only` leaves out the sessions of val worlds."""
    out = []
    for line in open(path):
        s = json.loads(line)
        if train_only and split.is_val(s):
            continue
        out += [t["user"].strip() for t in s["turns"]]
    return out


NAME_KEYS = {"name", "nickname", "first", "last", "given", "family", "display_name"}
COMMON = set("the and for with from new old day week month notes list home work family trip dinner call "
             "meeting party school book bill rent card login wifi password".split())


def name_tokens() -> set[str]:
    """Every word of a row name or nickname in any world, train or test. Train and test use
    different people and places by design, so the AUC gate masks them in both sets: it should
    measure how requests are phrased, not which world a message comes from."""
    out = set()

    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k in NAME_KEYS and isinstance(v, str):
                    out.update(w.lower() for w in re.findall(r"[A-Za-zÀ-ÿ']{3,}", v))
                else:
                    walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)
    files = glob.glob(str(HERE / "worlds" / "T*.json")) + glob.glob(str(HERE.parent / "eval" / "worlds" / "*.json"))
    for f in files:
        if not f.endswith(".keys.json"):
            walk(json.load(open(f)))
    return out - COMMON


def masker():
    names = name_tokens()
    return lambda t: " ".join("someone" if re.sub(r"[^\wÀ-ÿ']", "", w.lower()) in names else w for w in t.split())


EMBED_MODEL = "BAAI/bge-small-en-v1.5"


def _embed_cache_path() -> Path:
    """One shared on-disk cache of message embeddings (text -> vector), so the hygiene and mix checks, which embed the
    same train corpus and held-out pool on every run, pay for the model once. GATE_EMBED_CACHE overrides the path."""
    import os
    return Path(os.environ.get("GATE_EMBED_CACHE") or Path(os.environ.get("TMPDIR", "/tmp")) / "gate-embed-cache-bge-small.npz")


def _embed_cache_load() -> dict[str, np.ndarray]:
    path = _embed_cache_path()
    if not path.exists():
        return {}
    try:
        z = np.load(path, allow_pickle=False)
        keys = json.loads(str(z["keys_json"]))
        return dict(zip(keys, z["vecs"]))
    except Exception:  # a torn write by a concurrent run: recompute, never fail
        return {}


def _embed_cache_save(cache: dict[str, np.ndarray]) -> None:
    import os
    path = _embed_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    keys = list(cache)
    np.savez(tmp, keys_json=np.array(json.dumps(keys)), vecs=np.stack([cache[k] for k in keys]) if keys else np.zeros((0, 384), np.float32))
    os.replace(f"{tmp}.npz" if not str(tmp).endswith(".npz") else tmp, path)


def _embed_now(texts: list[str]) -> np.ndarray:
    import torch
    from transformers import AutoModel, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(EMBED_MODEL)
    mdl = AutoModel.from_pretrained(EMBED_MODEL).eval()
    out = []
    with torch.no_grad():
        for i in range(0, len(texts), 128):
            b = tok(texts[i:i + 128], padding=True, truncation=True, max_length=64, return_tensors="pt")
            e = mdl(**b).last_hidden_state[:, 0]
            out.append(torch.nn.functional.normalize(e, dim=-1).numpy())
    return np.concatenate(out) if out else np.zeros((0, 384), np.float32)


def embed(texts: list[str]):
    """Embeddings of `texts` in order; every text not yet in the shared cache is embedded now and added to it."""
    cache = _embed_cache_load()
    missing = [t for t in dict.fromkeys(texts) if t not in cache]
    if missing:
        vecs = _embed_now(missing)
        cache.update(zip(missing, vecs))
        _embed_cache_save(cache)
    if not texts:
        return np.zeros((0, 384), np.float32)
    return np.stack([cache[t] for t in texts])


def auc(a, b, seeds=3) -> float:
    return auc_stats(a, b, seeds)[0]


def auc_stats(a, b, seeds=3) -> tuple[float, float]:
    """Cross-validated AUC of a probe telling a from b: (mean, sd) over `seeds` resamplings."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import cross_val_score
    n = min(len(a), len(b))
    rs = []
    for seed in range(seeds):
        rng = np.random.default_rng(seed)
        X = np.concatenate([a[rng.permutation(len(a))[:n]], b[rng.permutation(len(b))[:n]]])
        y = np.r_[np.zeros(n), np.ones(n)]
        rs.append(cross_val_score(LogisticRegression(max_iter=2000), X, y, cv=5, scoring="roc_auc").mean())
    return float(np.mean(rs)), float(np.std(rs))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("gold", nargs="+")
    ap.add_argument("--json")
    ap.add_argument("--cap", type=int, default=3000, help="max train messages embedded")
    a = ap.parse_args()
    random.seed(0)
    train = [t for g in a.gold for t in user_texts(Path(g), train_only=True)]
    val, test = user_texts(SETS / "val.jsonl"), user_texts(SETS / "test.jsonl")
    sample = random.sample(train, min(a.cap, len(train)))
    # distribution on name-masked text (both sides); hygiene below on the raw text
    m = masker()
    M_train, M_val = embed([m(t) for t in sample]), embed([m(t) for t in val])
    v, sd = auc_stats(M_train, M_val, seeds=6)
    res = {"n_train": len(train), "n_val": len(val), "auc_authored_vs_val": v, "auc_sd": sd,
           "auc_baseline_val_halves": auc(M_val[0::2], M_val[1::2], seeds=6)}
    E_train, E_val = embed(sample), embed(val)
    res["auc_raw_authored_vs_val"] = auc(E_train, E_val, seeds=6)
    # hygiene: exact and near-duplicate user messages against val and test
    held = val + test
    E_held = np.concatenate([E_val, embed(test)])
    norm = lambda s: " ".join(s.lower().split())
    held_set = {norm(t) for t in held}
    exact = sorted({t for t in train if norm(t) in held_set and len(t.split()) >= MIN_WORDS})
    E_all = embed(train) if len(train) <= a.cap else np.concatenate([E_train, embed([t for t in train if t not in set(sample)])])
    order = sample + [t for t in train if t not in set(sample)] if len(train) > a.cap else train
    sims = E_all @ E_held.T
    near, seen = [], set()
    for i, j in zip(*np.where(sims >= DUP_COS)):
        # short generic messages ("how many is that") collide by nature; only a specific
        # message that mirrors a held-out one is leakage
        if norm(order[i]) in held_set or len(order[i].split()) < MIN_WORDS or i in seen:
            continue
        seen.add(i)
        near.append((order[i], held[j], float(sims[i, j])))
    near.sort(key=lambda x: -x[2])
    res.update({"exact_dups": exact, "near_dups": near[:50], "n_near": len(near)})

    res["auc_verdict"] = "diagnostic"
    res["hygiene_pass"] = not exact and not near
    print(f"train {len(train)} msgs vs val {len(val)} msgs")
    print(f"AUC authored vs val, names masked {v:.3f} ± {sd:.3f} (diagnostic); baseline val halves {res['auc_baseline_val_halves']:.3f}; "
          f"raw (unmasked, for reference) {res['auc_raw_authored_vs_val']:.3f}")
    print("  distribution is judged by authored/dist.py, not by this AUC")
    print(f"hygiene vs val + test: {len(exact)} exact, {len(near)} near (cos>={DUP_COS}) -> {'pass' if res['hygiene_pass'] else 'FAIL'}")
    for t, h, s in near[:10]:
        print(f"  {s:.3f}  {t!r}  ~  {h!r}")
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1, ensure_ascii=False)
    sys.exit(0 if res["hygiene_pass"] else 1)


if __name__ == "__main__":
    main()
