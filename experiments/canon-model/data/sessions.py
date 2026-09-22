"""Compose multi-turn sessions from paraphrase templates.

Each row is one TURN in a session: what the previous canonical was, what the
member then said, and what the canonical for that utterance is.  The five
moves are GRAMMAR.md 3's: new / substitute / refine / act / undo.

    python3 sessions.py
"""
import json
import os
import random
import re

import enumerate as EN
import paraphrase as PP

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = random.Random(615)

REFS = ["it", "them", "the other one", "the earlier one",
        "the last thing I added", "the 2nd one", "the 3rd one"]
REF_RE = re.compile(r"(?<![\w\"])(%s)(?![\w\"])"
                    % "|".join(re.escape(r) for r in REFS))


def head_kind_of(row, skeletons):
    return (skeletons[row["skel_id"]]["parts"].get("kind")
            if row["skel_id"] in skeletons else None)


def peel(node):
    """A nested Set as the sequence of turns that actually builds it."""
    ops, cur = [], node
    while cur["op"] in ("called", "filter", "during", "order", "first"):
        ops.append(cur)
        cur = cur["set"]
    ops.reverse()
    return cur, ops


def chains(skeletons):
    """Deep reads, reissued as `show X` -> refine -> refine -> act.

    This is what GRAMMAR.md 3 says a session does: a follow-up is a REWRITE of
    the previous canonical over the rows it answered, and the Ref terminals are
    what make it a tree edit.  A depth-4 read arrives this way in real use.
    """
    out, counter = [], 0
    for skel in skeletons.values():
        node = skel["parts"].get("set")
        if not node or not isinstance(node, dict):
            continue
        if EN.shape(node)["depth"] < 4:
            continue
        base, ops = peel(node)
        if len(ops) < 2 or base["op"] == "ref":
            continue
        kind = PP.head_kind(base)
        rng = random.Random("chain" + skel["skel_id"])
        held = "show %s" % EN.render_set(base)
        counter += 1
        base_row = {"turn": "show", "parts": {"set": base, "kind": kind},
                    "canonical": held}
        opening = PP.realise(base_row, rng, rng.choice(["natural", "terse",
                                                       "imperative", "spoken"]))
        if not opening:
            continue
        steps = [("new", "NONE", opening, held, "natural")]
        for index, op in enumerate(ops):
            ref = {"op": "ref", "ref": "them", "assume": kind}
            step = dict(op)
            step["set"] = ref
            target = "show %s" % EN.render_set(step)
            register = ["elliptical", "terse", "elliptical", "spoken",
                        "natural"][index % 5]
            utterance = PP.narrow(op, kind, rng)
            if not utterance:
                break
            steps.append(("refine", steps[-1][3], utterance, target, register))
        # the last turn folds or writes over what the chain narrowed to
        if skel["turn"] in ("value", "cmd"):
            ref = {"op": "ref", "ref": "them", "assume": kind}
            parts = dict(skel["parts"])
            parts["set"] = ref
            if skel["turn"] == "value":
                if parts.get("agg") == "balance":
                    parts = None
                else:
                    target = {"count": "count of them",
                              "project": "%s of them" % parts.get("field"),
                              }.get(parts.get("agg"),
                                    "%s %s of them" % (parts.get("agg"),
                                                       parts.get("field")))
            else:
                body = (" %s " % parts["args"]) if parts["args"] else ""
                target = "%s{%s} on them" % (parts["verb"], body)
            if parts:
                row = {"turn": skel["turn"], "parts": parts, "canonical": target}
                utterance = PP.realise(row, rng, rng.choice(["elliptical",
                                                             "natural", "terse"]))
                if utterance:
                    steps.append(("act", steps[-1][3], utterance, target,
                                  "elliptical"))
        for index, (move, prev, utterance, target, register) in enumerate(steps):
            out.append({
                "deep": False,
                "template_id": "c%06d_%d" % (counter, index),
                "skel_id": skel["skel_id"] + "_chain",
                "family": skel["family"] + "|chain",
                "turn": "show" if move != "act" else skel["turn"],
                "register": register,
                "move": move,
                "prev_mode": "none" if prev == "NONE" else "linked",
                "prev_canonical": prev,
                "utterance": utterance,
                "canonical": target,
            })
    return out


def main():
    skeletons = {s["skel_id"]: s for s in
                 json.load(open(os.path.join(HERE, "skeletons.json")))}
    rows = [json.loads(line) for line in
            open(os.path.join(HERE, "paraphrase.jsonl"))]

    # Candidate antecedents: a plain `show` of a board, which is what a session
    # holds when a follow-up points backwards.
    shows_by_kind, all_shows, cmds = {}, [], []
    for skel in skeletons.values():
        if skel["turn"] == "show" and not REF_RE.search(skel["canonical"]):
            all_shows.append(skel["canonical"])
            kind = skel["parts"].get("kind")
            if kind:
                shows_by_kind.setdefault(kind, []).append(skel["canonical"])
        if skel["turn"] == "cmd" and not REF_RE.search(skel["canonical"]):
            cmds.append(skel["canonical"])

    # A Set nested four deep is a legal canonical and not a sentence: nobody
    # says it in one breath.  Those skeletons are reissued below as REFINE
    # CHAINS, and the single-breath rows are flagged so build.py can cap them.
    deep_skeletons = {}
    for skel in skeletons.values():
        node = skel["parts"].get("set")
        deep_skeletons[skel["skel_id"]] = bool(
            node and isinstance(node, dict)
            and EN.shape(node)["depth"] >= 4)

    out = []
    for row in rows:
        skel = skeletons.get(row["skel_id"])
        kind = skel["parts"].get("kind") if skel else None
        has_ref = bool(REF_RE.search(row["canonical"]))
        prev_mode, prev, move = "none", "NONE", "new"

        if row["turn"] == "nothing":
            move, prev_mode = "undo", "linked"
            prev = RNG.choice(cmds)
        elif has_ref:
            # a rewrite of the previous canonical: a clause added over the rows
            # it answered (refine), or a write/fold wrapped round them (act)
            move = "refine" if row["turn"] == "show" else "act"
            pool = shows_by_kind.get(kind) or all_shows
            # C2 -- a referent's NUMBER follows the rows behind it.  A singular
            # ref wants an antecedent that resolved to one row (a `called`);
            # `them` wants one that resolved to several.
            singular = bool(re.search(r"(?<![\w\"])(it|that one|the other one"
                                      r"|the \d+(?:st|nd|rd|th) one)(?![\w\"])",
                                      row["canonical"]))
            narrowed = [c for c in pool
                        if ('called "' in c) == singular]
            prev, prev_mode = RNG.choice(narrowed or pool), "linked"
        elif row["register"] == "elliptical":
            move, prev_mode = "substitute", "same_skeleton"
            prev = row["canonical"]      # build.py refills it with other literals
        elif row["turn"] == "unparsed":
            move, prev_mode = "new", "none"
        elif RNG.random() < 0.18:
            move, prev_mode = "new", "linked"
            prev = RNG.choice(all_shows)   # a fresh thread after an old one

        out.append({
            "deep": deep_skeletons.get(row["skel_id"], False),
            "template_id": row["template_id"],
            "skel_id": row["skel_id"],
            "family": row["family"],
            "turn": row["turn"],
            "register": row["register"],
            "move": move,
            "prev_mode": prev_mode,
            "prev_canonical": prev,
            "utterance": row["utterance"],
            "canonical": row["canonical"],
        })

    out += chains(skeletons)

    path = os.path.join(HERE, "sessions.jsonl")
    with open(path, "w") as handle:
        for item in out:
            handle.write(json.dumps(item) + "\n")
    moves = {}
    for item in out:
        moves[item["move"]] = moves.get(item["move"], 0) + 1
    follow = sum(1 for i in out if i["prev_mode"] != "none")
    print("session turns   : %d" % len(out))
    print("by move         : %s" % dict(sorted(moves.items())))
    print("follow-ups      : %d (%.1f%%)" % (follow, 100.0 * follow / len(out)))


if __name__ == "__main__":
    main()
