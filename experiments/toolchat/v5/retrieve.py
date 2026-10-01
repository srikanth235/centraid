"""v5 vault-candidate retriever (SPEC v4/SPEC.md section 5).

ONE implementation, imported by data generation and by evaluation.
Pure Python, no dependencies, deterministic.

    candidates(request, vault, k=6) -> list[dict]
    render(request, cands) -> str
    tokens(text) -> list[str]   # the normalisation (stems, function words dropped)

A vault entry is {"kind": "tasks", "label": "..."} or {"field": "folder", "label": "..."}.
"""
import functools
import math
import re

FUNCTION_WORDS = frozenset(
    "the a an my our at of for to in on about with and is it that this what whats s".split()
)

_WORD = re.compile(r"[a-z0-9]+")


def _stem(w):
    for suf in ("ing", "ed", "es", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


@functools.lru_cache(maxsize=None)
def _tokens_cached(text):
    return tuple(_tokens(text))


def tokens(text):
    """Lowercase, strip possessive 's, split on non-alphanumerics, drop
    function words, light stemming. Order preserved, duplicates kept."""
    return list(_tokens_cached(text))


def _tokens(text):
    """Lowercase, strip possessive 's, split on non-alphanumerics, drop
    function words, light stemming. Order preserved, duplicates kept."""
    t = text.lower().replace("’", "'")
    t = re.sub(r"'s\b", "", t)
    t = t.replace("'", "")
    out = []
    for w in _WORD.findall(t):
        if w in FUNCTION_WORDS:
            continue
        out.append(_stem(w))
    return out


def _key(e):
    return ("kind", e["kind"]) if "kind" in e else ("field", e.get("field", ""))


BACKREF_WORDS = frozenset("she her he him they them it that those there".split())
BACKREF_PHRASES = ("the other", "the same")


def has_backref(request):
    """SPEC 5.1: the request contains a pronoun / back-reference."""
    low = request.lower().replace("’", "'")
    words = re.findall(r"[a-z]+", low)
    if any(w in BACKREF_WORDS for w in words):
        return True
    flat = " " + " ".join(words) + " "
    return any(" %s " % p in flat for p in BACKREF_PHRASES)


def scored_text(request, prev=None):
    """the text the vault is scored against (SPEC 5.1)"""
    if prev and has_backref(request):
        return request + " " + prev
    return request


def _exact(ltoks, qseq):
    """the label's normalised token sequence equals a contiguous span of the text's"""
    n = len(ltoks)
    if n == 0 or n > len(qseq):
        return False
    for i in range(len(qseq) - n + 1):
        if tuple(qseq[i:i + n]) == ltoks:
            return True
    return False


def scored(request, vault, prev=None):
    """Every vault entry with score > 0 as ((exact, score), entry), in the order
    `candidates` uses: exact whole-name matches first, then idf score desc, then
    label, then kind/field. Duplicate (kind/field, label) entries collapse to the first."""
    seen = set()
    entries = []
    for e in vault:
        kk = (_key(e), e["label"])
        if kk in seen:
            continue
        seen.add(kk)
        entries.append(e)
    n = len(entries)
    if n == 0:
        return []
    lseqs = [_tokens_cached(e["label"]) for e in entries]
    ltoks = [set(x) for x in lseqs]
    df = {}
    for s in ltoks:
        for w in s:
            df[w] = df.get(w, 0) + 1
    idf = {w: math.log(1.0 + n / c) for w, c in df.items()}
    text = scored_text(request, prev)
    qseq = tokens(text)
    q = list(dict.fromkeys(qseq))
    out = []
    for e, ls, lseq in zip(entries, ltoks, lseqs):
        score = 0.0
        for w in q:
            if w in ls:
                score += idf[w]
                continue
            if len(w) < 4:
                continue
            best = 0.0
            for lw in ls:
                # one direction only: the REQUEST token is a prefix of a LABEL
                # token ("lake" -> "lakeside"), never the reverse ("overdue" is
                # not a match for "over").
                if len(lw) > len(w) and lw.startswith(w):
                    best = max(best, idf[lw] / 2.0)
            score += best
        score = round(score, 9)
        if score > 0:
            out.append(((1 if _exact(lseq, qseq) else 0, score), e))
    out.sort(key=lambda x: (-x[0][0], -x[0][1], x[1]["label"], _key(x[1])))
    return out


_FAMILY = re.compile(r"\s*\((?=[^)]*\d)[^)]*\)\s*$")


def family(label):
    """A numbered near-duplicate's family name: "Weekly shop (wk 21)" ->
    "Weekly shop". A label without a trailing numbered group is its own family."""
    return _FAMILY.sub("", label) or label


@functools.lru_cache(maxsize=8)
def _family_sizes(vault_id, vault):
    sizes = {}
    for e in vault:
        kk = (_key(e), family(e["label"]))
        sizes.setdefault(kk, set()).add(e["label"])
    return {kk: len(v) for kk, v in sizes.items()}


def candidates(request, vault, k=6, prev=None, collapse=False, per_kind=None):
    """(collapse, per_kind are opt-in; the defaults are the section 5 rule.)

    collapse: numbered near-duplicates of one family ("Weekly shop (wk 01)",
    "(wk 21)", ...) take ONE slot, shown by the family name "Weekly shop";
    naming it matches every member, so the executor clarifies which.
    per_kind: at most this many candidates of one kind/field."""
    if collapse or per_kind:
        return _shaped(request, vault, k, prev, collapse, per_kind)
    return _plain(request, vault, k, prev)


def _shaped(request, vault, k, prev, collapse, per_kind):
    sizes = _family_sizes(id(vault), _Frozen(vault)) if collapse else {}
    out, seen, per = [], set(), {}
    for _, e in scored(request, vault, prev):
        if len(out) >= k:
            break
        kk = _key(e)
        if per_kind and per.get(kk, 0) >= per_kind:
            continue
        if collapse:
            fam = family(e["label"])
            if sizes.get((kk, fam), 1) > 1:
                if (kk, fam) in seen:
                    continue
                seen.add((kk, fam))
                e = dict(e, label=fam)
        per[kk] = per.get(kk, 0) + 1
        out.append(e)
    return out


class _Frozen:
    """Hashable identity wrapper so a vault list can key the family cache."""
    def __init__(self, vault):
        self.vault = vault

    def __hash__(self):
        return id(self.vault)

    def __eq__(self, other):
        return isinstance(other, _Frozen) and other.vault is self.vault

    def __iter__(self):
        return iter(self.vault)


def _plain(request, vault, k=6, prev=None):
    """Top-k vault entries for the request (SPEC sections 5 and 5.1).

    Scored text: the request, or request + " " + prev when the request holds a
    pronoun / back-reference (she her he him they them it that those there,
    "the other", "the same"); prev = the previous USER message's raw text.
    Rank: exact whole-name matches (the label's normalised tokens equal a
    contiguous span of the scored text's) above all partial matches; then
    score = sum over the text's distinct stems of idf(label stem) for an exact
    stem match, else idf/2 for the best prefix match (the text stem, >= 4
    chars, is a proper prefix of a label stem; never the reverse); idf =
    ln(1 + N/df) over the vault's labels (N = distinct entries). Ties broken
    by label, then kind/field. Only score > 0."""
    return [e for _, e in scored(request, vault, prev)[:k]]


def _show(e):
    name = e["kind"] if "kind" in e else e["field"]
    return '%s "%s"' % (name, e["label"])


def render(request, cands):
    if not cands:
        return request
    return request + "\nvault: " + "; ".join(_show(e) for e in cands)


def shown_labels(content):
    """Labels shown on a rendered user message's vault line (for the §5 literal rule)."""
    if "\nvault: " not in content:
        return []
    line = content.split("\nvault: ", 1)[1]
    return re.findall(r'"([^"]*)"', line)


if __name__ == "__main__":
    vault = [
        {"kind": "tasks", "label": "Reserve the lakeside cabin"},
        {"kind": "tasks", "label": "Pay the gutter cleaner"},
        {"kind": "events", "label": "Cabin weekend with Orla"},
        {"kind": "notes", "label": "Packing list"},
        {"kind": "people", "label": "Orla Vantree"},
        {"field": "folder", "label": "Travel"},
        {"field": "album_titles", "label": "Lakeside 2025"},
    ]
    assert tokens("What's Orla's cabin booking?") == ["orla", "cabin", "book"], tokens("What's Orla's cabin booking?")
    c = candidates("the cabin booking", vault)
    assert [e["label"] for e in c][:2] == ["Cabin weekend with Orla", "Reserve the lakeside cabin"], c
    assert render("hi there", candidates("hi there", vault)) == "hi there"
    r = render("show travel docs", candidates("show travel docs", vault))
    assert r == 'show travel docs\nvault: folder "Travel"', r
    assert shown_labels(r) == ["Travel"]
    assert candidates("lake photos", vault)[0]["label"] in ("Lakeside 2025", "Reserve the lakeside cabin")
    assert candidates("cabin", vault) == candidates("cabin", list(reversed(vault)))
    # prefix: request -> label only, request stem >= 4 chars
    v2 = [{"kind": "tasks", "label": "Over the hill"}, {"kind": "tasks", "label": "Lakeside walk"}]
    assert candidates("overdue tasks", v2) == [], candidates("overdue tasks", v2)
    assert candidates("lak", v2) == [] and candidates("lake", v2)[0]["label"] == "Lakeside walk"
    # 5.1 back-reference: "her" -> score request + previous user message
    v3 = [{"kind": "parties", "label": "Orla Vantree"}, {"kind": "events", "label": "Kayak lesson"},
          {"kind": "parties", "label": "Wendell Ashcombe"}]
    assert candidates("what's her number", v3) == []
    assert candidates("what's her number", v3, prev="when did I last see Orla")[0]["label"] == "Orla Vantree"
    assert candidates("kayak lesson times", v3, prev="Orla stuff") == [v3[1]]  # no back-reference: prev ignored
    assert has_backref("and the other one?") and has_backref("move it") and not has_backref("show my kayak lessons")
    # 5.1 exact whole-name match ranks above partial matches with a higher idf score
    v4 = [{"kind": "parties", "label": "Imogen"}, {"kind": "parties", "label": "Imogen Rookwood Yardley"},
          {"kind": "tasks", "label": "Call Imogen about Rookwood Yardley"}]
    got = [e["label"] for e in candidates("imogen rookwood", v4)]
    assert got[0] == "Imogen", got  # exact whole name beats the higher-scoring partial matches
    got = [e["label"] for e in candidates("call imogen about rookwood yardley", v4)]
    assert got == ["Call Imogen about Rookwood Yardley", "Imogen Rookwood Yardley", "Imogen"], got  # all exact: by score
    print(render("the cabin booking", c))
    print("ok")
