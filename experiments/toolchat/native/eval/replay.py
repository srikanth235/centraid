"""Replay a recorded model run through the CURRENT runtime and score it, on CPU, without the model.

    python3 replay.py --run RUN.jsonl --gold GOLD.jsonl --out DIR [--runtime PATH] [--jobs 4]
        [--only ID,ID] [--baseline-report REPORT.json] [--vaults DIR] [--name NAME]

For every gold session the recorded model messages (`steps[].model`, per session/turn/step) are fed
back through eval/run.py's `run_session` (the real driver: same turn loop, loop breaker, step cap)
by a backend that returns the recorded text instead of generating. The runtime is `--runtime`
(default: lib.NT, i.e. $NATIVETOOLS or target/debug/nativetools), run on vaults freshly seeded by
that same binary into DIR/vaults (world keys go to DIR/keys; the repo's *.keys.json are not
touched). The replay is scored with score.py against GOLD.

A turn is `diverged` when the runtime now answers the recorded calls with a different step
sequence (it ends the turn earlier/later, or the recording has no step to send): what exists is
replayed and scored as is. A turn the runtime now ends itself, as a retraction (`run.py`: one step
with `runtime: "never_mind"`), replaces the recording's steps and is not diverged. `response_changed` additionally counts steps whose runtime text changed.

Outputs in DIR: metrics.json (metrics.py schema; flipped_* are relative to the recorded run scored
by the same score.py), summary.md, report.json (score.py summary of the replay), replay.jsonl (the
replayed run file, readable by score.py), per_turn.json (per turn: before/after/diverged/...) and
slices/ (slices.py over the replay's failed turns). With --baseline-report (default: report.json
beside the run) the recorded scoring is cross-checked against that file's `failed` list.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "train"))  # hf_backend.compiled_message for --recompile

import lib  # noqa: E402
import metrics  # noqa: E402
import run as driver  # noqa: E402
import score as scorer  # noqa: E402
import slices  # noqa: E402


class RecordedBackend(driver.Backend):
    """Returns the recorded model message for (turn, step) of one session."""

    name = "replay"

    def __init__(self, recorded: dict[str, dict], tools_mode: str, recompile: bool = False):
        self.recorded = recorded
        self.tools_mode = tools_mode
        self.recompile = recompile
        self.rec = None

    def start_session(self, session: dict) -> None:
        self.rec = self.recorded.get(session["id"])
        self.overrun: list[int] = []  # turns that asked for a step the recording does not have

    def step(self, transcript, ctx):
        try:
            s = self.rec["turns"][ctx["turn"]]["steps"][ctx["step"]]
        except (TypeError, IndexError, KeyError):
            if ctx["turn"] not in self.overrun:
                self.overrun.append(ctx["turn"])
            return driver.StepOut(text="(no recorded step)", think_cut=False)
        if self.recompile and self.compile is not None:
            # --recompile: the recorded think's slots through THIS runtime's compile op (hf_backend does the same at record
            # time); a refusal keeps the recorded call, since there is no model to redraw a retry.
            from hf_backend import compiled_message

            text, how = compiled_message(s["model"], self.compile)
            return driver.StepOut(text=text, think_cut=bool(s.get("think_cut")), compile=how)
        return driver.StepOut(text=s["model"], think_cut=bool(s.get("think_cut")))


def seed_world(name: str, vaults: Path, keys_dir: Path, runtime: str) -> dict:
    wdir = lib.world_dir(name)
    out = vaults / name
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    vault = out / "vault"
    proc = subprocess.run([runtime, "seed", str(wdir / f"{name}.json"), str(vault)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"seed {name} failed: {proc.stderr[-500:]}")
    keys = json.loads(proc.stdout)["keys"]
    con = sqlite3.connect(vault)
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    con.execute("VACUUM")
    con.close()
    (keys_dir / f"{name}.keys.json").write_text(json.dumps(keys, indent=0, sort_keys=True) + "\n")
    return keys


def turn_key(sid: str, turn: int) -> str:
    return f"{sid}:t{turn}"


def pass_map(scored: dict) -> dict[str, bool]:
    return {turn_key(s["id"], i + 1): t["pass"] for s in scored["sessions"] for i, t in enumerate(s["turns"])}


def divergence(rec: dict | None, new: dict, overrun: list[int]) -> dict[int, dict]:
    """Per turn index: {diverged, response_changed} of the replayed record against the recording."""
    out = {}
    for ti, nt in enumerate(new["turns"]):
        ot = (rec or {}).get("turns", [])
        ot = ot[ti]["steps"] if ti < len(ot) else []
        ns = nt["steps"]
        if len(ns) == 1 and ns[0].get("runtime") == "never_mind":
            # the runtime ended the turn itself (a retraction): the recording's model steps are replaced by
            # that ending, which is the rule working, not a divergence
            out[ti] = {"diverged": False, "response_changed": 0}
            continue
        div = ti in overrun or len(ot) != len(ns) or any(
            bool((a.get("response") or {}).get("ends_turn")) != bool((b.get("response") or {}).get("ends_turn"))
            for a, b in zip(ot, ns))
        changed = sum(1 for a, b in zip(ot, ns)
                      if (a.get("response") or {}).get("text") != (b.get("response") or {}).get("text"))
        out[ti] = {"diverged": div, "response_changed": changed}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="recorded run file (run.py / run_batched.py, model hf)")
    ap.add_argument("--gold", required=True, help="gold set the run was made on (val/test/trainfit jsonl)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--runtime", help="nativetools binary to replay on (default: lib.NT)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--only", help="comma list of session ids")
    ap.add_argument("--baseline-report", help="report.json of the recorded run (default: beside --run)")
    ap.add_argument("--vaults", help="reuse worlds already seeded in DIR/<W>/vault (with DIR/<W>.keys.json); "
                                     "default: seed freshly into OUT/vaults")
    ap.add_argument("--name", help="metrics name (default: output directory name)")
    ap.add_argument("--keep-vaults", action="store_true")
    ap.add_argument("--recompile", action="store_true",
                    help="compile each recorded think's slots with the replay runtime (the call it executes may differ)")
    args = ap.parse_args()

    t0 = time.time()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    runtime = os.path.abspath(args.runtime) if args.runtime else lib.NT
    lib.NT = runtime  # Runtime() reads this module global
    gold = lib.read_jsonl(args.gold)
    if args.only:
        keep = set(args.only.split(","))
        gold = [g for g in gold if g["id"] in keep]
    recorded_all = lib.read_jsonl(args.run)
    recorded = {r["id"]: r for r in recorded_all}

    # worlds: seed with the replay runtime into OUT/vaults (or reuse --vaults)
    worlds = sorted({g["world"] for g in gold})
    keys_dir = out / "keys"
    keys_dir.mkdir(exist_ok=True)
    notes = []
    if args.vaults:
        vaults = Path(args.vaults)
        for w in worlds:
            shutil.copy(vaults / f"{w}.keys.json", keys_dir / f"{w}.keys.json") if (vaults / f"{w}.keys.json").exists() \
                else (keys_dir / f"{w}.keys.json").write_text((lib.world_dir(w) / f"{w}.keys.json").read_text())
    else:
        vaults = out / "vaults"
        vaults.mkdir(exist_ok=True)
        with cf.ThreadPoolExecutor(max_workers=max(1, min(args.jobs, len(worlds)))) as pool:
            seeded = list(pool.map(lambda w: seed_world(w, vaults, keys_dir, runtime), worlds))
        drift = [w for w, k in zip(worlds, seeded)
                 if (lib.world_dir(w) / f"{w}.keys.json").exists()
                 and json.loads((lib.world_dir(w) / f"{w}.keys.json").read_text()) != k]
        if drift:
            notes.append(f"seed keys differ from the repo's keys.json for worlds {drift}")
    t_seed = time.time() - t0
    lib.VAULTS = vaults

    def load_keys_local(name: str) -> dict:
        return json.loads((keys_dir / f"{name}.keys.json").read_text())

    lib.load_keys = scorer.load_keys = driver.load_keys = load_keys_local

    tools_modes = {r.get("tools_mode") for r in recorded_all if r.get("tools_mode")}
    tools_mode = tools_modes.pop() if len(tools_modes) == 1 else "sig"
    if tools_modes:
        notes.append(f"recorded tools_mode mixed; replaying under {tools_mode}")

    def one(session: dict):
        backend = RecordedBackend(recorded, tools_mode, args.recompile)
        try:
            rec = driver.run_session(session, backend)
        except Exception as error:  # noqa: BLE001
            return {"id": session["id"], "model": "replay", "error": repr(error), "turns": []}, backend
        return rec, backend

    results: dict[str, tuple[dict, RecordedBackend]] = {}
    with cf.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for rec, backend in pool.map(one, gold):
            results[rec["id"]] = (rec, backend)
    t_run = time.time() - t0 - t_seed

    errors = {sid: r["error"] for sid, (r, _) in results.items() if r.get("error")}
    new_run = [results[g["id"]][0] for g in gold]
    with open(out / "replay.jsonl", "w", encoding="utf-8") as fh:
        for r in new_run:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    # score the replay and the recording the same way
    after = scorer.score(new_run, gold)
    before = scorer.score([recorded[g["id"]] for g in gold if g["id"] in recorded], gold)
    text, summary = scorer.report(after, f"replay of {Path(args.run).name} vs {Path(args.gold).name}")
    (out / "report.json").write_text(json.dumps(summary, indent=1))
    p_after, p_before = pass_map(after), pass_map(before)

    # fidelity of the recorded scoring against its own report.json
    base_report = args.baseline_report or str(Path(args.run).with_name("report.json"))
    fidelity = None
    if os.path.exists(base_report) and not args.only:
        rep = json.load(open(base_report))
        rep_failed = {turn_key(x["id"], x["turn"]) for x in rep["failed"]}
        mine = {k for k, v in p_before.items() if not v}
        fidelity = {"report_failed": len(rep_failed), "rescored_failed": len(mine),
                    "disagree": sorted(rep_failed ^ mine)}

    div_ids, per_turn, resp_changed = [], [], 0
    for g in gold:
        rec, backend = results[g["id"]]
        dv = divergence(recorded.get(g["id"]), rec, backend.overrun)
        for ti in range(len(g["turns"])):
            k = turn_key(g["id"], ti + 1)
            d = dv.get(ti, {"diverged": True, "response_changed": 0})  # turn never run
            if d["diverged"]:
                div_ids.append(k)
            resp_changed += d["response_changed"]
            per_turn.append({"id": g["id"], "turn": ti + 1, "before": p_before.get(k, False),
                             "after": p_after[k], "diverged": d["diverged"],
                             "response_changed": d["response_changed"]})
    (out / "per_turn.json").write_text(json.dumps(per_turn, indent=0))
    up = [t for t in (turn_key(r["id"], r["turn"]) for r in per_turn if r["after"] and not r["before"])]
    down = [turn_key(r["id"], r["turn"]) for r in per_turn if r["before"] and not r["after"]]

    by_class = {}
    if summary["failed"]:
        recs = slices.slice_failed(summary["failed"], gold)
        by_class = slices.write_slices(recs, out / "slices")
    if errors:
        notes.append(f"{len(errors)} sessions errored: {dict(list(errors.items())[:3])}")
    if resp_changed:
        notes.append(f"{resp_changed} steps got a different runtime response text than recorded")
    notes.append(f"runtime {runtime}")
    m = metrics.build(args.name or out.resolve().name, args.run, args.gold, summary["sessions"],
                      summary["session_pass"], summary["turns"], summary["turn_pass"], by_class, up, down, div_ids,
                      "; ".join(notes))
    (out / "metrics.json").write_text(json.dumps(m, indent=1))

    sp_b = sum(s["pass"] for s in before["sessions"])
    tp_b = sum(p_before.values())
    lines = [f"# Replay: {m['name']}", "",
             f"- run `{args.run}`", f"- gold `{args.gold}`", f"- runtime `{runtime}`", "",
             "| | recorded | replayed |", "|---|---|---|",
             f"| session pass | {sp_b}/{m['sessions']} | {m['session_pass']}/{m['sessions']} ({100 * m['session_pass_rate']:.1f}%) |",
             f"| turn pass | {tp_b}/{m['turns']} | {m['turn_pass']}/{m['turns']} ({100 * m['turn_pass_rate']:.1f}%) |", "",
             f"- flipped up {len(up)}, flipped down {len(down)}, diverged turns {len(div_ids)}, "
             f"steps with changed runtime text {resp_changed}",
             f"- wall time: seed {t_seed:.0f}s, replay {t_run:.0f}s, jobs {args.jobs}"]
    if fidelity:
        lines.append(f"- recorded scoring vs {Path(base_report).name}: failed {fidelity['rescored_failed']} vs "
                     f"{fidelity['report_failed']}, per-turn disagreements {len(fidelity['disagree'])}")
    lines += ["", "## Failed turns by class", ""] + [f"- {n:4d} {c}" for c, n in m["by_class"].items()]
    if up or down:
        lines += ["", "## Flips", ""] + [f"- up: {k}" for k in up[:50]] + [f"- down: {k}" for k in down[:50]]
    if div_ids:
        lines += ["", "## Diverged", ""] + [f"- {k}" for k in div_ids[:50]]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    if not args.keep_vaults and not args.vaults:
        shutil.rmtree(vaults, ignore_errors=True)
    print("\n".join(lines[:14]))


if __name__ == "__main__":
    main()
