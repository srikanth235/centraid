"""Score a run against its items (DESIGN section 5).

    python3 score.py RUN.jsonl --items probe/dev.jsonl [--catalog catalog/schemas.json] [--json out.json]
    python3 score.py --pair A.jsonl B.jsonl --items probe/dev.jsonl

Per item: parse_ok, valid, tool_ok, name_ok, args_ok, correct. Strings compare after `norm`: casefold, apostrophes
dropped, other punctuation to space, whitespace folded, one leading the/a/an/my removed. `gold.args` values that are lists
are any-of (a candidate may itself be a list, compared as a sorted multiset of normalised strings). Args outside
`gold.args` and `gold.optional` fail args_ok; an optional arg that is present must match one of its accepted values.

Wrong write: the call is an `act` and gold is not that act (same name) on that target (`target` arg, when gold has one).
Over-ask: asked where gold did not. Under-ask: gold asked, the model did not. Repeat loop: a 20-token span (word-level
tokens: runs of word characters, or single punctuation) seen 3+ times in the think. Retrieval recall: gold name among the
candidates, over items whose gold has a name.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TOOLS = ("act", "load", "ask", "decline")
DECLINE_REASONS = ("out_of_scope", "never_mind", "fabricated_secret", "unbounded_destruction")
STRING_TYPES = ("mention", "text", "when", "amount")
LOOP_SPAN, LOOP_REPEATS = 20, 3

_ARTICLE = re.compile(r"^(?:the|a|an|my)\s+")
_TOKEN = re.compile(r"\w+|[^\w\s]")


def norm(value: Any) -> Any:
    """Normalise a string (see module doc); other values pass through."""
    if not isinstance(value, str):
        return value
    text = value.casefold().replace("'", "").replace("’", "")
    text = "".join(" " if _is_punct(ch) else ch for ch in text)
    text = " ".join(text.split())
    return _ARTICLE.sub("", text, count=1)


# A mention names a row; the runtime resolves it by fuzzy name match, so a kind noun or a "pic of" lead
# does not change which row it reaches. Mentions compare after removing them (the probe review, #1044).
KIND_NOUNS = ("task", "tasks", "note", "notes", "list", "folder", "pic", "pics", "photo", "photos", "picture",
              "album", "category", "account", "login", "item", "rule", "event", "doc", "document", "file",
              "notebook", "budget", "entry", "project", "calendar", "card", "contact")
_MENTION_LEAD = re.compile(r"^(?:(?:the )?one of|pic of|photo of|picture of|scan of|the one with) ")


def mention_norm(value: Any) -> Any:
    """`norm`, then drop a "pic of"-style lead and one trailing kind noun (never the whole mention)."""
    text = norm(value)
    if not isinstance(text, str):
        return text
    text = _MENTION_LEAD.sub("", text, count=1)
    text = _ARTICLE.sub("", text, count=1)
    words = text.split()
    if len(words) > 1 and words[-1] in KIND_NOUNS:
        words = words[:-1]
    return " ".join(words)


def _is_punct(ch: str) -> bool:
    import unicodedata

    return unicodedata.category(ch).startswith("P")


def _same(pred: Any, cand: Any, mention: bool = False) -> bool:
    if isinstance(cand, list) or isinstance(pred, list):
        if not (isinstance(cand, list) and isinstance(pred, list)):
            return False
        key = _mkey if mention else _key
        return sorted(map(key, pred)) == sorted(map(key, cand))
    if isinstance(pred, bool) or isinstance(cand, bool):
        return isinstance(pred, bool) and isinstance(cand, bool) and pred == cand
    if isinstance(pred, (int, float)) and isinstance(cand, (int, float)):
        return pred == cand
    if mention:
        return mention_norm(pred) == mention_norm(cand)
    return norm(pred) == norm(cand)


def _key(value: Any) -> str:
    return json.dumps(norm(value), sort_keys=True)


def _mkey(value: Any) -> str:
    return json.dumps(mention_norm(value), sort_keys=True)


def value_ok(pred: Any, accepted: Any, mention: bool = False) -> bool:
    """`accepted` a list means any-of its members (a member may itself be a list). When the prediction is a list,
    a flat accepted list also counts as that exact list (a list-typed param written as `["Ann", "Bo"]`)."""
    if not isinstance(accepted, list):
        return _same(pred, accepted, mention)
    if any(_same(pred, option, mention) for option in accepted):
        return True
    return isinstance(pred, list) and _same(pred, accepted, mention)


def check_valid(call: dict | None, catalog: dict) -> tuple[bool, str | None]:
    """(valid, reason). Tool known, name in the catalog with the right type, args are params, required present, types and enums legal."""
    if not call or call.get("error"):
        return False, "no_call"
    tool, name, args = call.get("tool"), call.get("name"), call.get("args")
    if tool not in TOOLS:
        return False, "unknown_tool"
    if not isinstance(args, dict):
        return False, "args_not_object"
    if tool == "ask":
        q = args.get("question")
        return (True, None) if isinstance(q, str) and q.strip() and set(args) == {"question"} else (False, "bad_question")
    if tool == "decline":
        r = args.get("reason")
        return (True, None) if r in DECLINE_REASONS and set(args) == {"reason"} else (False, "bad_reason")
    entry = catalog.get(name) if isinstance(name, str) else None
    if entry is None:
        return False, "unknown_name"
    if entry.get("type") != ("action" if tool == "act" else "view"):
        return False, "wrong_type"
    params = entry.get("params", {})
    for key, value in args.items():
        spec = params.get(key)
        if spec is None:
            return False, f"extra_arg:{key}"
        why = _type_error(value, spec)
        if why:
            return False, f"bad_value:{key}:{why}"
    for key, spec in params.items():
        if spec.get("required") and key not in args:
            return False, f"missing_arg:{key}"
    return True, None


def _type_error(value: Any, spec: dict) -> str | None:
    kind = spec.get("type")
    if kind in STRING_TYPES:
        return None if isinstance(value, str) and value.strip() else "not_string"
    if kind == "number":
        return None if isinstance(value, (int, float)) and not isinstance(value, bool) else "not_number"
    if kind == "bool":
        return None if isinstance(value, bool) else "not_bool"
    if kind == "enum":
        return None if value in spec.get("values", []) else "not_in_enum"
    if kind == "list":
        if not isinstance(value, list):
            return "not_list"
        inner = {"type": spec.get("items", "text")}
        if inner["type"] in ("enum",):
            return None
        for v in value:
            why = _type_error(v, inner)
            if why:
                return why
        return None
    return None  # unknown param type in the catalog: accept


def mention_keys(entry: dict | None) -> set[str]:
    """The params of a catalog entry that hold mentions (a `mention`, or a `list` of them)."""
    params = (entry or {}).get("params", {})
    return {k for k, p in params.items()
            if p.get("type") == "mention" or (p.get("type") == "list" and p.get("items") == "mention")}


def args_match(pred: dict, gold: dict, mentions: set[str] | frozenset[str] = frozenset()) -> bool:
    gold_args, optional = gold.get("args", {}), gold.get("optional", {})
    for key, accepted in gold_args.items():
        if key not in pred or not value_ok(pred[key], accepted, key in mentions):
            return False
    for key, value in pred.items():
        if key in gold_args:
            continue
        if key not in optional or not value_ok(value, optional[key], key in mentions):
            return False
    return True


def has_loop(think: str | None) -> bool:
    if not think:
        return False
    toks = _TOKEN.findall(think)
    if len(toks) < LOOP_SPAN * LOOP_REPEATS:
        return False
    seen = Counter(tuple(toks[i:i + LOOP_SPAN]) for i in range(len(toks) - LOOP_SPAN + 1))
    return any(c >= LOOP_REPEATS for c in seen.values())


def _target_ok(pred_args: dict, gold: dict) -> bool:
    for g in [gold, *gold.get("alts", [])]:
        gold_args = g.get("args", {})
        if "target" not in gold_args or ("target" in pred_args and value_ok(pred_args["target"], gold_args["target"], True)):
            return True
    return False


def score_item(item: dict, row: dict | None, catalog: dict) -> dict[str, Any]:
    gold = item["gold"]
    call = (row or {}).get("call")
    parsed = bool(call) and not call.get("error") and call.get("tool") in TOOLS
    valid, why = check_valid(call, catalog) if parsed else (False, "no_call")
    ptool = call.get("tool") if parsed else None
    tool_ok = parsed and ptool == gold["tool"]
    if tool_ok and gold["tool"] in ("act", "load"):
        name_ok = call.get("name") == gold.get("name")
    else:
        name_ok = tool_ok
    if not tool_ok or not name_ok:
        args_ok = False
    elif gold["tool"] == "ask":
        args_ok = True
    else:
        mentions = mention_keys(catalog.get(gold.get("name") or ""))
        # `alts`: other complete arg sets that are equally right (e.g. a symmetric pair such as link-transfer)
        args_ok = any(args_match(call["args"], g, mentions) for g in [gold, *gold.get("alts", [])])
    pargs = call.get("args") if parsed and isinstance(call.get("args"), dict) else {}
    wrong_write = bool(
        ptool == "act"
        and not (gold["tool"] == "act" and call.get("name") == gold.get("name") and _target_ok(pargs, gold))
    )
    cands = (row or {}).get("candidates") or []
    gname = gold.get("name") if gold["tool"] in ("act", "load") else None
    return {
        "id": item["id"], "app": item.get("app", ""), "gold_tool": gold["tool"],
        "parse_ok": parsed, "valid": bool(valid), "invalid_reason": why,
        "tool_ok": bool(tool_ok), "name_ok": bool(name_ok), "args_ok": bool(args_ok),
        "correct": bool(parsed and valid and tool_ok and name_ok and args_ok),
        "wrong_write": wrong_write,
        "over_ask": ptool == "ask" and gold["tool"] != "ask",
        "under_ask": gold["tool"] == "ask" and ptool != "ask",
        "capped": bool((row or {}).get("capped")),
        "think_tokens": (row or {}).get("think_tokens") or 0,
        "loop": has_loop((row or {}).get("think")),
        "retrieved": (gname in cands) if gname else None,
    }


def score_rows(items: list[dict], rows: list[dict], catalog: dict) -> list[dict]:
    """Score the items that have a row (a run with --limit covers a prefix). Order follows the run."""
    by_id = {i["id"]: i for i in items}
    return [score_item(by_id[r["id"]], r, catalog) for r in rows if r["id"] in by_id]


def _agg(scored: list[dict], all_items: int | None = None) -> dict[str, Any]:
    n = len(scored)
    if n == 0:
        return {"n": 0}

    def rate(key: str) -> float:
        return round(sum(1 for s in scored if s[key]) / n, 4)

    retr = [s["retrieved"] for s in scored if s["retrieved"] is not None]
    ask_gold = [s for s in scored if s["gold_tool"] == "ask"]
    return {
        "n": n, "correct": sum(s["correct"] for s in scored), "accuracy": rate("correct"),
        "parse_ok": rate("parse_ok"), "valid": rate("valid"), "tool_ok": rate("tool_ok"),
        "name_ok": rate("name_ok"), "args_ok": rate("args_ok"),
        "capped_rate": rate("capped"), "mean_think_tokens": round(sum(s["think_tokens"] for s in scored) / n, 1),
        "repeat_loop_rate": rate("loop"),
        "retrieval_recall": round(sum(retr) / len(retr), 4) if retr else None, "retrieval_n": len(retr),
        "wrong_write": sum(s["wrong_write"] for s in scored),
        "over_ask": sum(s["over_ask"] for s in scored), "over_ask_denominator": n - len(ask_gold),
        "under_ask": sum(s["under_ask"] for s in scored), "under_ask_denominator": len(ask_gold),
    }


def summarize(scored: list[dict]) -> dict[str, Any]:
    apps: dict[str, list[dict]] = defaultdict(list)
    for s in scored:
        apps[s["app"]].append(s)
    return {"overall": _agg(scored), "per_app": {a: _agg(v) for a, v in sorted(apps.items())}}


def pair(a: list[dict], b: list[dict]) -> dict[str, Any]:
    """Won = B correct and A not; lost = A correct and B not; z = (won - lost) / sqrt(won + lost). Items in both runs only."""
    ca = {s["id"]: s["correct"] for s in a}
    cb = {s["id"]: s["correct"] for s in b}
    ids = sorted(set(ca) & set(cb))
    won = sum(1 for i in ids if cb[i] and not ca[i])
    lost = sum(1 for i in ids if ca[i] and not cb[i])
    z = (won - lost) / math.sqrt(won + lost) if won + lost else 0.0
    return {"n": len(ids), "won": won, "lost": lost, "z": round(z, 3),
            "a_correct": sum(ca[i] for i in ids), "b_correct": sum(cb[i] for i in ids)}


COLUMNS = [("n", "n"), ("correct", "correct"), ("accuracy", "acc"), ("valid", "valid"), ("capped_rate", "capped"),
           ("mean_think_tokens", "think"), ("repeat_loop_rate", "loop"), ("retrieval_recall", "recall"),
           ("wrong_write", "wrong-write"), ("over_ask", "over-ask"), ("under_ask", "under-ask")]


def to_markdown(summary: dict) -> str:
    lines = ["| app | " + " | ".join(h for _, h in COLUMNS) + " |", "|" + " --- |" * (len(COLUMNS) + 1)]
    for label, agg in [("**all**", summary["overall"]), *summary["per_app"].items()]:
        cells = [("-" if agg.get(k) is None else str(agg.get(k, "-"))) for k, _ in COLUMNS]
        lines.append(f"| {label} | " + " | ".join(cells) + " |")
    return "\n".join(lines)


def read_jsonl(path: str | Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("run", nargs="?", help="a run's JSONL")
    ap.add_argument("--pair", nargs=2, metavar=("A", "B"), help="compare two runs on `correct`")
    ap.add_argument("--items", required=True)
    ap.add_argument("--catalog", default=str(HERE / "catalog" / "schemas.json"))
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args(argv)
    sys.path.insert(0, str(HERE))
    import catalog as catalog_mod

    catalog = catalog_mod.load(args.catalog)
    items = read_jsonl(args.items)
    if args.pair:
        a, b = (score_rows(items, read_jsonl(p), catalog) for p in args.pair)
        result = {"pair": pair(a, b), "a": summarize(a)["overall"], "b": summarize(b)["overall"]}
        print(f"B vs A on {result['pair']['n']} items: won {result['pair']['won']}, lost {result['pair']['lost']}, z {result['pair']['z']}"
              f" (A {result['pair']['a_correct']} correct, B {result['pair']['b_correct']})")
    elif args.run:
        scored = score_rows(items, read_jsonl(args.run), catalog)
        result = {**summarize(scored), "items": scored}
        print(to_markdown(result))
    else:
        ap.error("give RUN.jsonl or --pair A B")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(result, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
