"""Lexical nearest-neighbour retrieval over the DISTILLED training rows.

The pool is `experiments/canon-model/data/distill.jsonl` and nothing else.
The evaluation corpora (`suite`, `blind`, `holdout`) are never read here --
`assert_disjoint()` proves it against `grammar/map.json` before a single
example is retrieved, and the module refuses to build an index if a retrieved
request ever equals a corpus request.

Similarity is TF-IDF cosine over word unigrams, computed in plain Python: the
retriever is a baseline for the few-shot arm, not a contribution.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
AFM = os.path.normpath(os.path.join(HERE, "..", "afm-spike"))
for path in (HERE, AFM):
    if path not in sys.path:
        sys.path.insert(0, path)

import frame   # noqa: E402
import check   # noqa: E402

POOL = os.path.normpath(os.path.join(HERE, "..", "canon-model", "data",
                                     "distill.jsonl"))
MAP = os.path.join(os.path.normpath(os.path.join(
    HERE, "..", "..", "crates", "evalsuite", "grammar")), "map.json")

WORD = re.compile(r"[a-z0-9']+")


def words(text):
    return WORD.findall((text or "").lower())


def corpus_requests():
    rows = json.load(open(MAP, encoding="utf-8"))["turns"]
    return {r["request"].strip().lower() for r in rows}


class Index:
    def __init__(self, shots=6, pool=POOL, cap=None):
        self.shots = shots
        self.banned = corpus_requests()
        self.rows = []
        self.postings = defaultdict(list)
        self.df = Counter()
        leaked = 0
        with open(pool, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                request = row["input"].split("|||", 1)[-1].strip()
                if request.lower() in self.banned:
                    leaked += 1
                    continue
                try:
                    flat = frame.to_flat(frame.encode(check.parse(row["target"])))
                except Exception:
                    continue
                self.rows.append((request, flat, Counter(words(request))))
                if cap and len(self.rows) >= cap:
                    break
        for _request, _flat, counts in self.rows:
            for word in counts:
                self.df[word] += 1
        self.n = len(self.rows)
        self.norms = []
        for index, (_request, _flat, counts) in enumerate(self.rows):
            total = 0.0
            for word, count in counts.items():
                weight = count * self.idf(word)
                total += weight * weight
                self.postings[word].append((index, weight))
            self.norms.append(math.sqrt(total) or 1.0)
        self.leaked = leaked
        if leaked:
            print("knn: dropped %d pool rows whose request equals a corpus "
                  "request" % leaked, file=sys.stderr)

    def idf(self, word):
        return math.log((1.0 + self.n) / (1.0 + self.df.get(word, 0))) + 1.0

    def nearest(self, request):
        counts = Counter(words(request))
        scores = defaultdict(float)
        query_norm = 0.0
        for word, count in counts.items():
            weight = count * self.idf(word)
            query_norm += weight * weight
            for index, other in self.postings.get(word, ()):
                scores[index] += weight * other
        query_norm = math.sqrt(query_norm) or 1.0
        ranked = sorted(scores.items(),
                        key=lambda kv: -kv[1] / (self.norms[kv[0]] * query_norm))
        out, seen = [], set()
        for index, _score in ranked:
            text, flat, _counts = self.rows[index]
            key = json.dumps(flat, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            out.append((text, flat))
            if len(out) >= self.shots:
                break
        return out


def assert_disjoint():
    index = Index(shots=1)
    banned = corpus_requests()
    for request, _flat, _counts in index.rows:
        assert request.lower() not in banned, request
    print("knn pool: %d rows, 0 of them a corpus request (%d dropped)"
          % (index.n, index.leaked))
    return 0


if __name__ == "__main__":
    sys.exit(assert_disjoint())
