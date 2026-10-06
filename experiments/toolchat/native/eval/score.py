"""Score a run against gold, by effect only (SPEC §10), and write the §13 report.

    python3 score.py RUN.jsonl --gold sets/val.jsonl [--out report.md] [--json report.json]

A run file has one JSON object per session:
    {"id": "...", "model": "...", "turns": [{"user": "...", "steps": [
        {"model": "<raw model message>", "response": {<runtime response: text, ends_turn, effect>},
         "think_cut": false}, ...]}, ...]}

Gold (see gold.py) gives each turn a list of acceptable effects; a turn passes when its effect
matches any of them. Session strict pass = every turn passes. Clean turn pass = passing clean turns
over clean turns, where a turn is downstream (not clean) when an earlier turn of its session already
failed: the first failure of a session is clean, every later turn is not. Clean turn pass is the
number to steer by; session pass is the reported outcome.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from lib import load_keys, load_world, read_jsonl, turn_effect

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


# ---------------------------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------------------------


def match_value(want, got) -> bool:
    if isinstance(want, dict):
        if want.get("any"):
            return True
        if "oneof" in want:
            return any(match_value(w, got) for w in want["oneof"])
        if "has" in want:
            return isinstance(got, str) and all(w.lower() in got.lower() for w in want["has"])
        if "prefix" in want:
            return isinstance(got, str) and got.startswith(want["prefix"])
        raise ValueError(f"unknown matcher {want}")
    if isinstance(got, dict) and "amount" in got:  # money: {"amount": 24.0, "unit": "USD"}
        if isinstance(want, dict) and "amount" in want:
            return match_value(want["amount"], got["amount"]) and match_value(want.get("unit"), got.get("unit"))
        return match_value(want, got["amount"])
    if want is None or got is None:
        return want is got
    if isinstance(want, bool) or isinstance(got, bool):
        return want == got
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return abs(want - got) < 0.005
    if isinstance(want, str) and isinstance(got, str):
        if DATE_RE.match(want) and DATE_RE.match(got):
            return got.startswith(want)
        return want.strip().casefold() == got.strip().casefold()
    return str(want).casefold() == str(got).casefold()


class Ids:
    """World keys -> vault ids, and back (for readable reports)."""

    def __init__(self, world: str):
        self.keys = load_keys(world)
        self.by_id = {v["id"]: k for k, v in self.keys.items()}
        people = load_world(world).get("people", [])
        self.person_names = {self.keys[p["key"]]["id"]: p["name"] for p in people if p.get("key") in self.keys}
        self.person_names[self.keys["me"]["id"]] = load_world(world)["me"]
        self.created: list[str] = []  # rows the run created in earlier turns, in order

    def id(self, key: str) -> str:
        if key.startswith("+"):  # "+1" = the first row created in this session (earlier turn)
            index = int(key[1:]) - 1
            return self.created[index] if index < len(self.created) else f"<no created row {key}>"
        if key not in self.keys:
            raise KeyError(f"gold names unknown world key {key!r}")
        return self.keys[key]["id"]

    def name(self, vid: str) -> str:
        return self.by_id.get(vid, vid[:8])


def diff_match(want: dict, got: dict, ids: Ids, settle: list | None = None) -> tuple[list[str], list[str]]:
    """Compare a gold diff with a turn's net diff.

    Returns (problems, unwanted): problems fail the turn; unwanted are vault changes gold did
    not specify (a subset of problems), counted by the wrong-write guardrail.
    """
    problems: list[str] = []
    unwanted: list[str] = []
    got_rows = {r["id"]: r for r in got.get("rows", [])}
    matched: set[str] = set()
    created_ids: list[str] = []
    for spec in want.get("rows", []):
        if "new" in spec:
            hit = None
            for rid, row in got_rows.items():
                if rid in matched or row["change"] != "created" or row["kind"] != spec["new"]:
                    continue
                fields = row["fields"]
                if all(f in fields and match_value(v, fields[f][1]) for f, v in spec.get("fields", {}).items()):
                    hit = rid
                    break
            if hit is None:
                cands = [r for r in got_rows.values() if r["change"] == "created" and r["kind"] == spec["new"]
                         and r["id"] not in matched]
                if cands:
                    problems.append(f"created {spec['new']} with wrong fields: "
                                    f"{ {f: v[1] for f, v in cands[0]['fields'].items()} } want {spec.get('fields')}")
                    unwanted.append(f"created {spec['new']} with wrong fields")
                    matched.add(cands[0]["id"])
                    created_ids.append(cands[0]["id"])
                else:
                    problems.append(f"missing create of {spec['new']} {spec.get('fields')}")
                continue
            matched.add(hit)
            created_ids.append(hit)
            continue
        rid = ids.id(spec["key"])
        row = got_rows.get(rid)
        if row is None:
            problems.append(f"missing change on {spec['key']} {spec.get('fields') or spec.get('change')}")
            continue
        matched.add(rid)
        change = spec.get("change", "updated")
        if row["change"] != change:
            problems.append(f"{spec['key']}: change {row['change']} want {change}")
            unwanted.append(f"{spec['key']}: {row['change']}")
            continue
        if change == "updated":
            want_fields = spec.get("fields", {})
            for field, (_old, new) in row["fields"].items():
                if field not in want_fields:
                    problems.append(f"{spec['key']}: unexpected field {field} -> {new!r}")
                    unwanted.append(f"{spec['key']}.{field}")
                elif not match_value(want_fields[field], new):
                    problems.append(f"{spec['key']}.{field} = {new!r}, want {want_fields[field]!r}")
                    unwanted.append(f"{spec['key']}.{field} wrong value")
            for field in want_fields:
                if field not in row["fields"]:
                    problems.append(f"{spec['key']}: field {field} unchanged")
    # settle_up zeroes the pairwise balance: a person row whose only change is `balance` -> 0 is the
    # settlement itself when gold settles with that person (the settle check below judges it)
    settle_names = {s["name"] for s in settle or []}
    for rid, row in got_rows.items():
        if (rid not in matched and row["kind"] == "person" and set(row["fields"]) == {"balance"}
                and ids.person_names.get(rid) in settle_names):
            new = row["fields"]["balance"][1]
            if isinstance(new, dict) and abs(float(new.get("amount") or 0)) < 0.005:
                matched.add(rid)
    for rid, row in got_rows.items():
        if rid not in matched:
            label = ids.name(rid)
            problems.append(f"unwanted {row['change']} of {row['kind']} {label} {list(row['fields'])}")
            unwanted.append(f"{row['change']} {label}")
    want_links = []
    for link in want.get("links", []):
        want_links.append((link["change"], link["from"], link["to"]))
    got_links = [(l["change"], l["from"], l["to"]) for l in got.get("links", [])]
    used = set()
    for change, a, b in want_links:
        hit = None
        for i, (gc, ga, gb) in enumerate(got_links):
            if i in used or gc != change:
                continue
            ok_a = ga in created_ids if a == "new" else ga == ids.id(a)
            ok_b = gb in created_ids if b == "new" else gb == ids.id(b)
            if ok_a and ok_b:
                hit = i
                break
        if hit is None:
            problems.append(f"missing link {change} {a} -> {b}")
        else:
            used.add(hit)
    for i, (gc, ga, gb) in enumerate(got_links):
        if i not in used:
            problems.append(f"unwanted link {gc} {ids.name(ga)} -> {ids.name(gb)}")
            unwanted.append(f"link {gc}")
    return problems, unwanted


def value_match(want: dict, got: dict) -> bool:
    if "groups" in want:
        groups = {str(g["key"]).casefold(): g["values"] for g in got.get("groups") or []}
        if set(groups) != {str(k).casefold() for k in want["groups"]}:
            return False
        return all(value_list_match(v, groups[str(k).casefold()]) for k, v in want["groups"].items())
    return value_list_match(want["values"], got.get("values") or [])


def value_list_match(want: list, got: list) -> bool:
    if len(want) != len(got):
        return False
    rest = list(got)
    for w in want:
        hit = next((g for g in rest if (g.get("unit") or None) == (w.get("unit") or None)
                    and abs(float(g["amount"]) - float(w["amount"])) < 0.005), None)
        if hit is None:
            return False
        rest.remove(hit)
    return True


def judge_accept(accept: dict, eff: dict, ids: Ids) -> tuple[bool, list[str], list[str]]:
    """One acceptable gold effect against the turn effect -> (pass, problems, unwanted)."""
    problems, unwanted = diff_match(accept.get("diff", {}), eff["diff"], ids, accept.get("settle"))
    kind = accept["type"]
    got = eff["kind"]
    if kind == "rows":
        if got != "rows":
            problems.append(f"ended in {got}, want rows")
        else:
            want = [ids.id(k) for k in accept["rows"]]
            if accept.get("order"):
                if eff["rows"] != want:
                    problems.append("rows or their order differ")
            elif set(eff["rows"]) != set(want):
                extra = [ids.name(r) for r in set(eff["rows"]) - set(want)]
                miss = [ids.name(r) for r in set(want) - set(eff["rows"])]
                problems.append(f"rows differ: extra {extra[:6]} missing {miss[:6]}")
    elif kind == "value":
        if got != "value":
            problems.append(f"ended in {got}, want value")
        elif not value_match(accept, eff["value"]):
            problems.append(f"value {eff['value'].get('values') or eff['value'].get('groups')} want "
                            f"{accept.get('values') or accept.get('groups')}")
    elif kind == "diff":
        # judged by the vault diff: a write that landed counts even if the model then looped or hit
        # the step cap (those are counted as diagnostics); ending in ask/decline is a different act
        if got in ("ask", "decline"):
            problems.append(f"ended in {got}, want a write")
        for key in accept.get("already", []):
            if ids.id(key) not in eff["already"]:
                problems.append(f"no already: for {key}")
        for rev in accept.get("reveal", []):
            if not any(rev["contains"] in text for text in eff["revealed"]):
                problems.append(f"secret of {rev['key']} not revealed")
        for settle in accept.get("settle", []):
            if not any(settle["name"] in text for text in eff["settle_texts"]):
                problems.append(f"no settle_up for {settle['name']}")
            elif settle.get("amount") and not any(settle["amount"] in t for t in eff["settle_texts"]):
                problems.append(f"settle_up amount differs from {settle['amount']}")
    elif kind == "ask":
        if got != "ask":
            problems.append(f"ended in {got}, want ask")
        else:
            missing = [k for k in accept.get("candidates", []) if ids.id(k) not in eff["options"]]
            if missing:
                problems.append(f"ask options miss {missing}")
    elif kind == "decline":
        if got != "decline":
            problems.append(f"ended in {got}, want decline")
        elif eff.get("reason") not in accept["reasons"]:
            problems.append(f"decline {eff.get('reason')} want {accept['reasons']}")
    else:
        raise ValueError(kind)
    if kind != "diff" and eff["revealed"]:
        problems.append("revealed a secret gold did not ask for")
    return (not problems), problems, unwanted


def judge_turn(gold_turn: dict, steps: list[dict], ids: Ids) -> dict:
    eff = turn_effect(steps)
    results = [judge_accept(a, eff, ids) for a in gold_turn["gold"]]
    passed = any(r[0] for r in results)
    best = next((r for r in results if r[0]), min(results, key=lambda r: (len(r[1]), len(r[2]))))
    wrong_write = all(r[2] for r in results)  # an unwanted change under every acceptable reading
    return {"pass": passed, "problems": best[1], "wrong_write": wrong_write, "effect": eff,
            "gold_type": gold_turn["gold"][0]["type"]}


# ---------------------------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------------------------


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def pct(k: int, n: int) -> str:
    return f"{k}/{n} = {100 * k / n:.1f}%" if n else f"{k}/0"


def clean_turns(turns: list[dict]) -> list[dict]:
    """One session's clean turns: those up to and including its first failed turn. A turn is downstream
    when an earlier turn of its session already failed (slices.py flags the same turns `downstream`)."""
    first = next((i for i, t in enumerate(turns) if not t["pass"]), len(turns))
    return turns[: first + 1]


def score(run: list[dict], gold: list[dict]) -> dict:
    gold_by_id = {g["id"]: g for g in gold}
    run_by_id = {r["id"]: r for r in run}
    sessions = []
    for g in gold:
        r = run_by_id.get(g["id"])
        ids = Ids(g["world"])
        turns = []
        for ti, gt in enumerate(g["turns"]):
            steps = r["turns"][ti]["steps"] if r and ti < len(r["turns"]) else []
            res = judge_turn(gt, steps, ids) if steps else {
                "pass": False, "problems": ["not run"], "wrong_write": False,
                "effect": turn_effect([]), "gold_type": gt["gold"][0]["type"]}
            ids.created += [row["id"] for row in res["effect"]["diff"]["rows"] if row["change"] == "created"]
            res["tags"] = gt.get("tags", [])
            res["think_cut"] = sum(1 for s in steps if s.get("think_cut"))
            res["gold_rows"] = [ids.id(k) for k in gt["gold"][0].get("rows", [])] \
                if gt["gold"][0]["type"] == "rows" else None
            turns.append(res)
        sessions.append({"id": g["id"], "world": g["world"], "tags": g.get("tags", []), "blocked": g.get("blocked"),
                         "pass": all(t["pass"] for t in turns), "turns": turns})
    missing = [rid for rid in run_by_id if rid not in gold_by_id]
    return {"sessions": sessions, "extra_run_ids": missing}


def report(scored: dict, title: str) -> tuple[str, dict]:
    sessions = scored["sessions"]
    turns = [t for s in sessions for t in s["turns"]]
    n_s, k_s = len(sessions), sum(s["pass"] for s in sessions)
    lo, hi = wilson(k_s, n_s)
    n_t, k_t = len(turns), sum(t["pass"] for t in turns)
    clean_t = [t for s in sessions for t in clean_turns(s["turns"])]
    n_c, k_c = len(clean_t), sum(t["pass"] for t in clean_t)
    lo_c, hi_c = wilson(k_c, n_c)
    n_b = sum(1 for s in sessions if s.get("blocked"))
    k_nb = sum(1 for s in sessions if s["pass"] and not s.get("blocked"))
    ww = sum(t["wrong_write"] for t in turns)
    # §14 conventions the prompt never states (tagged `convention` through conventions.py): the pass rate
    # without them is what a zero-shot model can be held to
    conv = lambda t: "convention" in t["tags"]  # noqa: E731
    free_turns = [t for t in turns if not conv(t)]
    free_sessions = [s for s in sessions if any(not conv(t) for t in s["turns"])]
    k_free = sum(all(t["pass"] for t in s["turns"] if not conv(t)) for s in free_sessions)
    clean = [s for s in sessions if not any(conv(t) for t in s["turns"])]
    ask_turns = [t for t in turns if t["gold_type"] == "ask"]
    non_ask = [t for t in turns if t["gold_type"] != "ask"]
    under = sum(1 for t in ask_turns if t["effect"]["kind"] in ("rows", "value", "act"))
    over = sum(1 for t in non_ask if t["effect"]["kind"] == "ask")
    by_type: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for t in turns:
        by_type[t["gold_type"]][0] += t["pass"]
        by_type[t["gold_type"]][1] += 1
    by_tag: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for s in sessions:
        for t in s["turns"]:
            for tag in set(t["tags"]) | set(s["tags"]):
                by_tag[tag][0] += t["pass"]
                by_tag[tag][1] += 1
    tp = fp = fn = 0
    for t in turns:
        if t["gold_rows"] is None:
            continue
        want = set(t["gold_rows"])
        got = set(t["effect"].get("rows") or []) if t["effect"]["kind"] == "rows" else set()
        tp += len(want & got)
        fp += len(got - want)
        fn += len(want - got)
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / (tp + fn) if tp + fn else 1.0
    loops = sum(1 for t in turns if t["effect"]["kind"] == "loop")
    caps = sum(1 for t in turns if t["effect"]["kind"] == "cap")
    cuts = sum(t["think_cut"] for t in turns)
    kinds = Counter(t["effect"]["kind"] for t in turns)
    lines = [f"# {title}", "",
             f"**Session strict pass: {pct(k_s, n_s)}** (95% Wilson CI {100 * lo:.1f}–{100 * hi:.1f}%)", "",
             f"**Clean turn pass: {pct(k_c, n_c)}** (95% Wilson CI {100 * lo_c:.1f}–{100 * hi_c:.1f}%; "
             f"turns after a session's first failure left out)", "",
             f"Turn pass (all turns): {pct(k_t, n_t)}", "",
             f"Excluding {n_b} sessions blocked by a logged runtime issue: {pct(k_nb, n_s - n_b)}", "",
             f"Without §14-convention turns ({n_t - len(free_turns)} turns tagged `convention`): "
             f"session pass {pct(k_free, len(free_sessions))} (convention turns ignored), "
             f"turn pass {pct(sum(t['pass'] for t in free_turns), len(free_turns))}; "
             f"sessions with no convention turn {pct(sum(s['pass'] for s in clean), len(clean))}", "",
             "## Guardrails", "",
             f"- wrong-write rate (turns with any unwanted vault change ÷ all turns): {pct(ww, n_t)}",
             f"- under-ask (acted or answered where gold asks ÷ gold-ask turns): {pct(under, len(ask_turns))}",
             f"- over-ask (asked where gold acts or answers ÷ gold non-ask turns): {pct(over, len(non_ask))}",
             "", "## Turn pass by outcome type", "", "| gold type | pass |", "|---|---|"]
    for kind in ("rows", "value", "diff", "ask", "decline"):
        if kind in by_type:
            lines.append(f"| {kind} | {pct(*by_type[kind])} |")
    lines += ["", "## Turn pass by slice", "", "| slice | pass |", "|---|---|"]
    for tag in sorted(by_tag):
        lines.append(f"| {tag} | {pct(*by_tag[tag])} |")
    lines += ["", "## Diagnostics", "",
              f"- row precision {precision:.3f}, recall {recall:.3f} (over gold-rows turns; tp {tp}, fp {fp}, fn {fn})",
              f"- loop turns {loops}, cap turns {caps}, think_cut steps {cuts}",
              f"- turn endings: {dict(kinds)}", ""]
    fails = [(s["id"] + (f" (blocked: {s['blocked']})" if s.get("blocked") else ""), i, t)
             for s in sessions for i, t in enumerate(s["turns"]) if not t["pass"]]
    lines += [f"## Failed turns ({len(fails)})", ""]
    for sid, i, t in fails:
        lines.append(f"- {sid} t{i + 1} [{t['gold_type']} / got {t['effect']['kind']}]: {'; '.join(t['problems'])[:300]}")
    summary = {"sessions": n_s, "session_pass": k_s, "ci95": [lo, hi],
               "turns_clean": n_c, "turn_pass_clean": k_c, "ci95_clean": [lo_c, hi_c],
               "turns": n_t, "turn_pass": k_t, "wrong_write": ww,
               "without_convention": {"session_pass": [k_free, len(free_sessions)],
                                      "turn_pass": [sum(t["pass"] for t in free_turns), len(free_turns)],
                                      "clean_sessions": [sum(s["pass"] for s in clean), len(clean)]},
               "under_ask": [under, len(ask_turns)], "over_ask": [over, len(non_ask)],
               "by_type": dict(by_type), "by_tag": dict(by_tag), "precision": precision, "recall": recall,
               "loops": loops, "caps": caps, "think_cut": cuts,
               "failed": [{"id": sid, "turn": i + 1, "gold_type": t["gold_type"], "got": t["effect"]["kind"],
                           "problems": t["problems"]} for sid, i, t in fails]}
    return "\n".join(lines) + "\n", summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run")
    parser.add_argument("--gold", required=True)
    parser.add_argument("--out")
    parser.add_argument("--json")
    parser.add_argument("--only", help="comma list of session ids (score a subset)")
    args = parser.parse_args()
    gold = read_jsonl(args.gold)
    run = read_jsonl(args.run)
    if args.only:
        keep = set(args.only.split(","))
        gold = [g for g in gold if g["id"] in keep]
    else:
        ran = {r["id"] for r in run}
        if len(ran) < len(gold):
            print(f"note: run covers {len(ran)} of {len(gold)} gold sessions; unrun sessions fail", file=sys.stderr)
    scored = score(run, gold)
    text, summary = report(scored, f"{Path(args.run).name} vs {Path(args.gold).name}")
    if args.out:
        Path(args.out).write_text(text)
    if args.json:
        Path(args.json).write_text(json.dumps(summary, indent=1))
    print(text if not args.out else text.split("## Turn pass by outcome")[0])


if __name__ == "__main__":
    main()
