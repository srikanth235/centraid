"""Model-facing catalog derived from the app manifests (DESIGN section 1).

`python3 catalog.py` regenerates catalog/schemas.json byte-for-byte deterministically.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
APPS_DIR = REPO / "crates" / "apps"
DEFAULT_PATH = HERE / "catalog" / "schemas.json"
SKIP_APPS = {"kit"}
SUMMARY_CAP = 160

# Plumbing a member never says. One reason each (DESIGN rule 6).
PLUMBING: dict[str, str] = {
    "blob": "staged bytes, never spoken",
    "size": "byte count computed by the stage door",
    "media_type": "detected from the bytes",
    "origin": "sync origin handle",
    "records": "sync payload",
    "complete": "sync flag: whether the read was complete",
    "zone": "IANA zone resolved by the runtime from the phone",
    "tz": "IANA zone resolved by the runtime from the phone",
    "timing": "zoned/floating/all-day inferred from the date phrase",
    "after": "paging cursor",
    "seq": "version sequence number, resolved by the runtime from 'previous' or 'yesterday'",
    "position": "ordering key computed by the runtime",
    "instance_key": "occurrence key computed by the runtime",
    "confirm": "confirmation is the card's job",
    "ref": "opaque follow handle held by the runtime",
    "credential_id": "passkey credential material",
    "user_handle": "passkey credential material",
    "algorithm": "passkey credential material",
    "form": "photo/video/scan detected from the bytes",
    "width": "image metadata computed from the bytes",
    "height": "image metadata computed from the bytes",
    "duration_s": "media metadata computed from the bytes",
    "offset_min": "UTC offset computed from the capture time",
    "edited_from": "provenance link set by the editor, not said",
    "lat": "coordinate read from the photo",
    "lon": "coordinate read from the photo",
    "burst": "burst group computed by the camera",
    "phash": "perceptual hash computed from the bytes",
    "thumbhash": "thumbnail hash computed from the bytes",
    "rel": "edge relation fixed by the action",
    "content": "statement bytes picked on the phone",
    "exact": "verbatim line used to locate the checklist item; the title already carries it",
    "correct": "spell-correction switch of the search box",
}

WHEN_FIELDS = {
    "starts", "ends", "due", "from", "to", "since", "through", "date", "month", "day",
    "original_start", "original_start_local", "taken_at", "met", "birthday",
    "entry_date", "month_day", "opening_on",
}
WHEN_DESC = re.compile(r"\b(instant|ISO|RFC 3339)\b")
BOOL_NAMES = {"ascending"}  # integer 0/1 on the wire, a yes/no to the member

# `<x>_id` -> kind when it differs from x (the kind ids come from the manifests).
ID_NAME = {"party": "person", "txn": "transaction", "kind_concept": "kind"}
ID_OF = {
    "party": "person", "txn": "transaction", "other": "transaction", "item": "locker_item",
    "point": "contact_point", "field": "locker_field", "kind_concept": "workout_kind",
    "activity": "workout", "list": "people_list", "from": "category", "into": "category",
    "related": "person", "project": "list",
}
# `id` is the row acted on; for these the row is not of the action's own kind.
TARGET_OF = {
    "people.add-note": "person", "people.add-task": "person", "people.add-gift": "person",
    "people.add-important-date": "person", "people.save-contact-channel": "person",
    "photos.set-place": "photo",
}
# `parent` / `parent_id` is of the action's kind unless listed.
PARENT_OF = {"agenda.create-section": "list"}
# from/to on edge actions: the kind of each end when the manifest settles it.
EDGE_OF = {
    "photos.add-to-album": {"from": "photo", "to": "album"},
    "photos.remove-from-album": {"from": "photo", "to": "album"},
    "people.merge-people": {"from": "person", "into": "person"},
}
LIST_MENTION_OF = {"attendees": "person"}
# Array-of-object fields flattened into scalar params (one element).
FLATTEN = {"health.record-days": "days"}


def base_type(schema: dict) -> str:
    """JSON-schema type with null stripped; 'enum' when an enum is present."""
    if "enum" in schema:
        return "enum"
    t = schema.get("type")
    if isinstance(t, list):
        t = next((x for x in t if x != "null"), "string")
    return t or "string"


def _first_sentence(text: str) -> str:
    text = " ".join(text.split())
    m = re.search(r"(?<=[.!?])\s+(?=[A-Z`\[(])", text)
    return text[: m.start()] if m else text


_TAIL_WORDS = {"the", "a", "an", "and", "or", "of", "to", "with", "in", "on", "for", "its", "is", "does"}


def _cap(s: str) -> str:
    """Cut at the last clause break (or word) under the cap, never on a dangling word."""
    if len(s) <= SUMMARY_CAP:
        return s
    head = s[:SUMMARY_CAP]
    breaks = [m.start() for m in re.finditer(r"[,;:] ", head)]
    if breaks and breaks[-1] >= 60:
        return head[: breaks[-1]]
    words = head.rsplit(" ", 1)[0].split()
    while words and words[-1].lower().strip(",;:") in _TAIL_WORDS:
        words.pop()
    return " ".join(words)


def summarize(description: str) -> str:
    s = _first_sentence(description)
    s = re.sub(r"\s*\(#\d+[^)]*\)", "", s)
    s = re.sub(r"\s+through\s+`?[a-z]+[._][a-z_]+(?:\.[a-z_]+)?`?(?=[\s,.:;—]|$)", "", s)
    s = re.sub(r"\s*(?:\((?:kind|rel) \w+\)|with kind \w+)", "", s)
    s = s.replace("`", "").replace(" — ", ", ").replace(" —", "")
    if len(s) > SUMMARY_CAP:
        s = re.sub(r"\s*\([^()]*\)", "", s)
    s = re.sub(r",(\s*,)+", ",", s)
    s = re.sub(r"\s+([,.:;])", r"\1", s)
    s = _cap(s)
    return s.rstrip(".").strip(" ,;:—") + "."


class Ctx:
    def __init__(self, app: str, entry: dict, is_action: bool) -> None:
        self.app = app
        self.name = entry["name"]
        self.full = f"{app}.{self.name}"
        self.is_action = is_action
        self.kind = entry["kind"]
        self.verb = (entry.get("verb") or "read").split(":")[0]
        self.props: dict = entry["input"].get("properties", {})
        self.required = set(entry["input"].get("required", []))
        self.sealed = set(entry.get("sealed") or [])


def _spec(type_: str, required: bool, **extra: Any) -> dict:
    out = {"type": type_}
    out.update(extra)
    out["required"] = required
    return out


def _mention(required: bool, of: str | None) -> dict:
    return _spec("mention", required, **({"of": of} if of else {}))


def _id_field(ctx: Ctx, name: str, required: bool) -> tuple[str, dict] | str | None:
    """Mention params from `<x>_id`; None when `name` is not an id field."""
    if not name.endswith("_id"):
        return None
    x = name[:-3]
    of = ID_OF.get(x, x)
    claimed = "id" in ctx.props or ("item_id" in ctx.props and x != "item")
    paired = x in ("from", "into", "other", "parent")
    if ctx.is_action and not claimed and not paired and (of == ctx.kind or x == "item"):
        if not required and ctx.verb in ("create", "import"):
            return "id minted by the vault"
        return "target", _mention(required, of)
    if x == "parent":
        return "parent", _mention(required, PARENT_OF.get(ctx.full, ctx.kind))
    return ID_NAME.get(x, x), _mention(required, of)


def _derive(ctx: Ctx, name: str, schema: dict) -> tuple[str, dict] | str:
    """Return (param name, spec) or a drop reason."""
    req = name in ctx.required
    t = base_type(schema)
    if name in ctx.sealed:
        return "sealed secret: entered on the card, never by the model"
    if name == "id":
        if not req and ctx.verb in ("create", "import"):
            return "id minted by the vault"
        return "target", _mention(req, TARGET_OF.get(ctx.full, ctx.kind))
    if name.startswith("typing_"):
        return "keystroke-level draft state"
    if name in PLUMBING:
        return PLUMBING[name]
    if t == "object" or (t == "array" and schema.get("items", {}).get("type") == "object"):
        return "structured payload, not speakable"
    if t == "enum" and len(schema["enum"]) == 1:
        return f"constant {schema['enum'][0]!r}, filled by the runtime"
    if name == "rule":
        return "repeat", _spec("when", req)
    if t == "integer" and (name == "amount_minor" or name.endswith("_minor")) or name in ("min", "max") and ctx.app == "money":
        return name.removesuffix("_minor"), _spec("amount", req)
    if ctx.is_action and ctx.full in EDGE_OF and name in EDGE_OF[ctx.full]:
        return name, _mention(req, EDGE_OF[ctx.full][name])
    if ctx.is_action and name in ("from", "to", "into"):
        return name, _mention(req, None)
    if name in WHEN_FIELDS or WHEN_DESC.search(schema.get("description", "")):
        return name, _spec("when", req)
    if name in ("tag_concept_ids", "tags"):
        return "tags", _spec("list", req, items="mention", of="tag")
    if name == "ids":
        return "targets", _spec("list", req, items="mention", of=ctx.kind)
    if name.endswith("_ids"):
        x = name[:-4]
        return x + "s", _spec("list", req, items="mention", of=ID_OF.get(x, x))
    ided = _id_field(ctx, name, req)
    if ided:
        return ided
    if name == "parent":
        return name, _mention(req, PARENT_OF.get(ctx.full, ctx.kind))
    if name == "attendees" or name in LIST_MENTION_OF:
        return name, _spec("list", req, items="mention", of=LIST_MENTION_OF[name])
    if t == "array":
        item = base_type(schema.get("items", {}))
        return name, _spec("list", req, items={"integer": "number"}.get(item, "text" if item == "string" else item))
    if t == "enum":
        return name, _spec("enum", req, values=list(schema["enum"]))
    if t == "boolean" or name in BOOL_NAMES or name.endswith("_only"):
        return name, _spec("bool", req)
    if t in ("integer", "number"):
        return name, _spec("number", req)
    return name, _spec("text", req)


def _flatten(ctx: Ctx, field: str, params: dict, dropped: dict) -> None:
    items = ctx.props[field]["items"]
    req = set(items.get("required", []))
    for sub, schema in items["properties"].items():
        derived = _derive(Ctx_for_item(ctx, req), sub, schema)
        params[derived[0]] = derived[1]
    dropped[field] = "flattened to one reading: day, metric, value"


def Ctx_for_item(ctx: Ctx, req: set[str]) -> Ctx:
    sub = Ctx.__new__(Ctx)
    sub.__dict__.update(ctx.__dict__)
    sub.required = req
    sub.props = {}
    return sub


def derive_entry(app: str, entry: dict, is_action: bool) -> dict:
    ctx = Ctx(app, entry, is_action)
    params: dict[str, dict] = {}
    dropped: dict[str, str] = {}
    flatten = FLATTEN.get(ctx.full)
    for name, schema in ctx.props.items():
        if name == flatten:
            _flatten(ctx, name, params, dropped)
            continue
        if ctx.full == "locker.set-addresses" and name == "addresses":
            params[name] = _spec("list", name in ctx.required, items="text")
            continue
        out = _derive(ctx, name, schema)
        if isinstance(out, str):
            dropped[name] = out
        else:
            assert out[0] not in params, f"{ctx.full}: param {out[0]} collides"
            params[out[0]] = out[1]
    card = bool(ctx.sealed) or entry.get("confirmation", "none") != "none" \
        or bool(entry.get("bulk")) or ctx.verb == "reveal"
    return {
        "id": ctx.full,
        "type": "action" if is_action else "view",
        "app": app,
        "kind": ctx.kind,
        "verb": ctx.verb,
        "card": card,
        "summary": summarize(entry["description"]),
        "phrasings": list(entry.get("phrasings") or []),
        "params": params,
        "dropped": dropped,
    }


def manifest_paths() -> list[Path]:
    return sorted(p for p in APPS_DIR.glob("*/manifest.json") if p.parent.name not in SKIP_APPS)


def build() -> dict:
    hashes: dict[str, str] = {}
    entries: list[dict] = []
    for path in manifest_paths():
        raw = path.read_bytes()
        hashes[path.relative_to(REPO).as_posix()] = hashlib.sha256(raw).hexdigest()
        m = json.loads(raw)
        for e in m.get("actions", []):
            entries.append(derive_entry(m["id"], e, True))
        for e in m.get("queries", []):
            entries.append(derive_entry(m["id"], e, False))
    entries.sort(key=lambda e: e["id"])
    return {"manifests": hashes, "entries": entries}


def dumps(data: dict) -> str:
    return json.dumps(data, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


def write(path: Path = DEFAULT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(build()), encoding="utf-8")


def load(path: str | Path = DEFAULT_PATH) -> dict[str, dict]:
    """id -> entry."""
    p = Path(path)
    if not p.is_absolute() and not p.exists():
        p = HERE / p
    data = json.loads(p.read_text(encoding="utf-8"))
    return {e["id"]: e for e in data["entries"]}


if __name__ == "__main__":
    write()
