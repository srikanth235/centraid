"""The runtime's metadata table (nativetools export), the generator's only vocabulary source."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import rt

_DIR = Path(os.environ.get("NATIVE_EXPORT", Path(tempfile.gettempdir()) / "nativetools-export"))


def _load() -> dict:
    _DIR.mkdir(parents=True, exist_ok=True)
    if not (_DIR / "metadata.json").exists():       # build.sh exports once, before parallel workers start
        rt.run("export", str(_DIR))
    return json.loads((_DIR / "metadata.json").read_text())


META = _load()
PHRASES = json.loads((_DIR / "phrases.json").read_text())
CONST = META["constants"]
ROW_CAP = CONST["ROW_CAP"]


def _kname(k: str) -> str:
    return "locker item" if k == "locker_item" else k


KIND = {_kname(k["kind"]): k for k in META["kinds"]}
VERBS_BY_KIND = {name: set(k["verbs"]) for name, k in KIND.items()}
DATED = {name for name, k in KIND.items() if k.get("date")}
FIELDS = {name: {f["name"]: f for f in k["fields"]} for name, k in KIND.items()}
LINKS = {name: {l["kind"] if l["kind"] != "locker_item" else "locker item" for l in k["links"]} for name, k in KIND.items()}
DATE_LABEL = {name: k["date"]["label"] for name, k in KIND.items() if k.get("date")}
