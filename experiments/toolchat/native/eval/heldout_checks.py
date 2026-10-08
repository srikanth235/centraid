"""The checks that mean something only with the held-out files (R-1088-16): run by `python3 artefacts.py verify-heldout`.

    python3 eval/heldout_checks.py            # from experiments/toolchat/native

`regen.FIXES` are hand corrections of val turns (gold or reference calls the conventions do not derive). Each is written for one
message of one val session and names world rows, so it can be checked only against the val set and the worlds it was written on:
the session is in `sets/val.jsonl`, its turn's message is the one the fix expects (`regen.apply_fix` raises otherwise), and every
row the fix's gold names is a row of the session's world. The density targets of `authored/gen/collide.py` (`TARGETS`) are held to
the eval worlds they were measured on. The public suite holds the fixes to their shape (`test_audit.py`); it
cannot hold them to the data, which it does not have. Exits 1 on any problem, and 2 when a held-out file is absent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_sets  # noqa: E402
import regen  # noqa: E402

sys.path.insert(0, str(HERE.parent / "authored" / "gen"))
import collide  # noqa: E402

EXPECTED_KINDS = {("T03", "d_glasses"): "debt"}  # "who's that to": the debt row beside the person (D-1044-15)


def main() -> int:
    val = HERE / "sets" / "val.jsonl"
    if not val.is_file():
        print(f"FAIL {val} is absent: the fixes are held to the val set (python3 artefacts.py fetch)")
        return 2
    sessions = {s["id"]: s for s in map(json.loads, val.read_text(encoding="utf-8").splitlines()) if s}
    problems: list[str] = []
    for (sid, number), fix in sorted(regen.FIXES.items()):
        session = sessions.get(sid)
        if session is None or not 1 <= number <= len(session["turns"]):
            problems.append(f"{sid} t{number}: no such turn in sets/val.jsonl")
            continue
        try:
            regen.apply_fix(session["turns"][number - 1], fix, sid, number)
        except ValueError as why:
            problems.append(str(why))
        kinds = regen.world_kinds(session["world"])
        named = {name for accept in [*fix.get("gold", []), *fix.get("add", [])] for name in build_sets.gold_names(accept)}
        problems += [f"{sid} t{number}: the fix names {name!r}, which is no row of the world {session['world']}"
                     for name in sorted(named) if not name.startswith("+") and name != "me" and name not in kinds]
        problems += [f"{sid} t{number}: {name!r} is a {kinds.get(name)}, want a {kind}"
                     for (world, name), kind in EXPECTED_KINDS.items()
                     if world == session["world"] and name in named and kinds.get(name) != kind]
    for profile in collide.TARGETS:  # the density targets of the collision worlds were measured on A to D
        if collide.measured_targets(profile) != collide.TARGETS[profile]:
            problems.append(f"collide.TARGETS[{profile!r}] is not what the eval worlds A to D measure now")
    for line in problems:
        print(f"FAIL {line}")
    print(f"heldout_checks: {len(regen.FIXES)} fixes checked against sets/val.jsonl and their worlds, "
          f"{len(collide.TARGETS)} density profiles checked against A to D, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
