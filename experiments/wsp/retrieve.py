"""Pure-Python BM25 over the catalog (DESIGN section 2). Deterministic; ties by id."""
from __future__ import annotations

import math
import re
from collections import Counter

K1 = 1.5
B = 0.75
STOPWORDS = frozenset(
    "a an the to of on in at for from by with and or is it its this that these those my me i we you "
    "please can could would should do does did be am are was were as so if up out into than then "
    "just some any".split()
)
_TOKEN = re.compile(r"[a-z0-9]+")


def _stem(tok: str) -> str:
    if len(tok) > 4 and tok.endswith("ies"):
        return tok[:-3] + "y"
    if len(tok) > 3 and tok.endswith("s") and not tok.endswith(("ss", "us")):
        return tok[:-1]
    return tok


def tokenize(text: str) -> list[str]:
    return [_stem(t) for t in _TOKEN.findall(text.lower()) if t not in STOPWORDS]


def doc_text(entry: dict) -> str:
    """id words, kind, verb, summary, phrasings."""
    parts = [entry["id"], entry["kind"].replace("_", " "), entry["verb"].replace("_", " "), entry["summary"]]
    parts.extend(entry.get("phrasings", []))
    return " ".join(parts)


class Index:
    def __init__(self, catalog: dict[str, dict]) -> None:
        self.ids = sorted(catalog)
        self.docs = [Counter(tokenize(doc_text(catalog[i]))) for i in self.ids]
        self.lens = [sum(d.values()) for d in self.docs]
        self.avg = (sum(self.lens) / len(self.lens)) if self.lens else 0.0
        df: Counter[str] = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = len(self.docs)
        self.idf = {t: math.log(1 + (n - c + 0.5) / (c + 0.5)) for t, c in df.items()}

    def scores(self, query: str) -> list[float]:
        terms = Counter(tokenize(query))
        out = []
        for doc, length in zip(self.docs, self.lens):
            s = 0.0
            for t in terms:
                f = doc.get(t, 0)
                if f:
                    norm = f * (K1 + 1) / (f + K1 * (1 - B + B * length / self.avg))
                    s += self.idf[t] * norm
            out.append(s)
        return out


_CACHE: dict[int, tuple[dict, Index]] = {}


def _index(catalog: dict[str, dict]) -> Index:
    hit = _CACHE.get(id(catalog))
    if hit and hit[0] is catalog:
        return hit[1]
    idx = Index(catalog)
    _CACHE[id(catalog)] = (catalog, idx)
    return idx


def candidates(text: str, catalog: dict[str, dict], k: int = 8) -> list[str]:
    """Top-k catalog ids for `text`: score descending, then id ascending."""
    idx = _index(catalog)
    ranked = sorted(zip(idx.scores(text), idx.ids), key=lambda p: (-p[0], p[1]))
    return [i for _, i in ranked[:k]]
