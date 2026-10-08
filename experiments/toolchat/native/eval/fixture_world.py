"""A made-up household for the unit tests of the scorer and of the gold conventions (R-1088-16).

The tests of `score.py`, `regen.py` and the audit conventions are built from hand-made runs against a world: they name rows by
world key and need each row's kind, and a few of them need a fact of the world (which tasks are open or in progress, how many
events carry one name). They once read a held-out household for it. A public checkout has no held-out file, so they read this
one: every row they name, with the kind and the facts they rely on, and no more. The ids are made up (a name-based UUID), so no
runtime is needed and nothing is written to the tree; `install` writes the world and its keys into a temporary directory and
points `lib.WORLDS` there.

    import fixture_world
    WORLD = fixture_world.install()        # "FX": lib.load_keys("FX"), score.Ids("FX"), regen.Sess({"world": "FX"}, ...)
"""

from __future__ import annotations

import atexit
import json
import shutil
import tempfile
import uuid
from pathlib import Path

import lib

NAME = "FX"
ME = "Priya Raman"

# kind -> {key: fields}; a row's `name` defaults to its key
TASKS = {
    # open
    "dogfood": {"name": "Buy dog food", "effort": 60}, "amazon": {"name": "Amazon return", "priority": 1, "effort": 120},
    "vetbill": {"name": "Pay the vet bill"},
    "drycleaning": {"name": "Pick up dry cleaning"}, "faucet": {"name": "Fix the faucet"},
    "acfilter": {"name": "Change the AC filter"}, "ammaalbum": {"name": "Make amma's album"}, "ammapkg": {"name": "Send amma's package"},
    "bbcabin": {"name": "Book the cabin"}, "bbpass": {"name": "Renew the park pass"}, "bbplan": {"name": "Plan the trip"},
    "biketire": {"name": "Fix the bike tire"}, "callamma": {"name": "Call amma"}, "carreg": {"name": "Renew the car registration"},
    "caterer": {"name": "Call the caterer"}, "deposit": {"name": "Pay the deposit"}, "gym": {"name": "Renew the gym card", "status": "cancelled"},
    "slides": {"name": "Finish the slides"},
    # a series: four tasks of one name, the first two done
    "rent0": {"name": "Pay rent", "due": "2026-07-01", "completed": "2026-07-01T09:00"},
    "rent1": {"name": "Pay rent", "due": "2026-08-01", "completed": "2026-08-01T09:00"},
    "rent2": {"name": "Pay rent", "due": "2026-09-01"}, "rent3": {"name": "Pay rent", "due": "2026-10-01"},
    # in progress, with the effort in minutes
    "roadmap": {"name": "Write the roadmap", "status": "in_progress", "effort": 240, "priority": 1},
    "fridge": {"name": "Clean the fridge", "status": "in_progress", "effort": 40},
    "readbook": {"name": "Read the book club book", "status": "in_progress"},
    # completed
    "plants": {"name": "Water the plants", "completed": "2026-10-10T09:00"},
}
EVENTS = {
    "vet": {"name": "Vet", "date": "2026-10-15T10:00"}, "dentist": {"name": "Dentist", "date": "2026-10-16T09:00"},
    "haircut": {"name": "Haircut", "date": "2026-10-18T11:00"}, "pottery": {"name": "Pottery class", "date": "2026-10-19T18:00"},
    "physical": {"name": "Physical", "date": "2026-10-14T15:00"},
    "oneonone0": {"name": "One on one", "date": "2026-10-20T10:00"},
    **{f"oneonone{i}": {"name": "One on one", "date": f"2026-10-{20 + i % 8:02d}T10:00"} for i in range(1, 11)},
    **{f"yoga{i}": {"name": "Yoga with Ananya", "date": f"2026-10-{15 + i // 2:02d}T0{7 + i % 2}:00"} for i in range(17)},
}
PEOPLE = {"chloe": {"name": "Chloe Park"}, "meera_i": {"name": "Meera Iyer"}, "meera_s": {"name": "Meera Shah"},
          "jordan_b": {"name": "Jordan Blake"}, "craig": {"name": "Craig Boyd"}, "kenji": {"name": "Kenji Mori"},
          "tomas": {"name": "Tomás Herrera", "nickname": "Tomi"}, "arjun": {"name": "Arjun Rao"}}
# a debt links to the person it is with
DEBTS = {"uber": {"name": "Uber", "person": "chloe", "amount": 32.4}, "magazine": {"name": "Magazine", "person": "meera_i"},
         "jordan_gas": {"name": "Gas money", "person": "jordan_b"}, "acltix": {"name": "Tickets", "person": "jordan_b"}}
GROUPS = {"casa": {"name": "Casa Bills", "currency": "USD"}}
DOCUMENTS = {"lease": {"name": "Lease"}}
LOCKER = {"wifi": {"name": "Home wifi", "password": "biscuit-2208"}, "officewifi": {"name": "Office wifi", "password": "lanyard-4417"}}
FOLDERS = {"house": {"name": "House"}}
LISTS = {"home": {"name": "Home"}}
PHOTOS = {"en0": {"name": "en0"}, "en1": {"name": "en1"}}

SECTIONS = {"people": PEOPLE, "groups": GROUPS, "events": EVENTS, "tasks": TASKS, "debts": DEBTS, "documents": DOCUMENTS, "locker": LOCKER,
            "folders": FOLDERS, "lists": LISTS, "photos": PHOTOS}
KINDS = {section: kind for section, kind in lib.SECTION_KIND.items()}


def world() -> dict:
    out: dict = {"me": ME, "currency": "USD"}
    for section, rows in SECTIONS.items():
        out[section] = [{"key": key, **({"name": key} | fields)} for key, fields in rows.items()]
    return out


def keys() -> dict[str, dict]:
    """World key -> vault id and kind, as `seed_worlds.py` writes it; the ids are made up (a UUID of the key)."""
    found = {"me": {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "fixture-world:me")), "kind": "person"}}
    for section, rows in SECTIONS.items():
        for key in rows:
            found[key] = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"fixture-world:{key}")), "kind": KINDS[section]}
    return found


_DIR: Path | None = None


def install(name: str = NAME) -> str:
    """Write the world and its keys to a temporary directory and point `lib.WORLDS` at it; the world's name."""
    global _DIR
    if _DIR is None:
        _DIR = Path(tempfile.mkdtemp(prefix="fixture-world-"))
        atexit.register(shutil.rmtree, _DIR, True)
    (_DIR / f"{name}.json").write_text(json.dumps(world()), encoding="utf-8")
    (_DIR / f"{name}.keys.json").write_text(json.dumps(keys()), encoding="utf-8")
    lib.WORLDS = _DIR
    return name
