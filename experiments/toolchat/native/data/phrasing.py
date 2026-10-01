"""Fill phrasing-family templates; split templates between train and val."""
from __future__ import annotations

import hashlib
import json
import random
import re
from pathlib import Path

from families import F

PH = re.compile(r"\{([A-Z0-9_]+)\}")
MARK = re.compile(r"\[\[(.+?)\]\]")
VAL_ONLY_FAMILIES = {"rows.frame.any"}          # whole family held out for val
VAL_SHARE = 5                                   # 1 in 5 paraphrases is val-only
TIMEWORD = re.compile(r"\b(tmrw|tomorrow|today|tonight|yesterday|morning|evening|weekend|monday|tuesday|wednesday|"
                      r"thursday|friday|saturday|sunday|next week|this week|later)\b", re.I)


def _h(s: str) -> int:
    return int(hashlib.sha256(s.encode()).hexdigest()[:8], 16)


class Phrasing:
    def __init__(self, pool_path: Path | None):
        self.pool = json.loads(Path(pool_path).read_text()) if pool_path and Path(pool_path).exists() else {}

    def templates(self, fid: str, split: str) -> list[str]:
        seeds = F[fid]["t"]
        para = self.pool.get(fid, {}).get("para", [])
        if not any("{DATE}" in t for t in seeds) and not fid.startswith("decline."):
            # a paraphrase must not add a time the gold action does not carry
            para = [t for t in para if not TIMEWORD.search(PH.sub("", t))]
        if fid == "rows.when.diary":
            para = [t for t in para if "diary" in t.lower()]      # the convention needs the word
        if fid in VAL_ONLY_FAMILIES:
            return (seeds + para) if split == "val" else []
        v = [t for t in para if _h(t) % VAL_SHARE == 0]
        if not v and para:
            v = [min(para, key=_h)]        # every family keeps at least one val-only paraphrase
        if split == "val":
            return v or seeds
        return seeds + [t for t in para if t not in v]

    def available(self, fid: str, split: str) -> bool:
        return bool(self.templates(fid, split))

    def render(self, fid: str, slots: dict, rng: random.Random, split: str) -> tuple[str, str, str]:
        """-> (message, deciding phrase, template)"""
        ts = [t for t in self.templates(fid, split) if set(PH.findall(t)) <= set(slots)]
        if not ts:
            raise KeyError(f"no template for {fid} with slots {sorted(slots)}")
        t = rng.choice(ts)
        deciding = " … ".join(MARK.findall(t))
        msg = MARK.sub(lambda m: m.group(1), t)
        msg = PH.sub(lambda m: str(slots[m.group(1)]), msg)
        msg = re.sub(r"\s+", " ", msg).strip()
        # a template preposition before a phrase that brings its own ("from since last june")
        msg = re.sub(r"\b(from|for|on|in|during|by) (since|from|between|on|the last|up to) ", r"\2 ", msg, flags=re.I)
        if msg and rng.random() < 0.5 and msg[0].isalpha():
            msg = msg[0].upper() + msg[1:]
        # the preposition cleanup may have eaten the end of a marked phrase ("[[same for]] since …")
        parts = []
        for part in deciding.split(" … ") if deciding else []:
            while part and part.lower() not in msg.lower() and " " in part:
                part = part.rsplit(" ", 1)[0]
            if part and part.lower() in msg.lower():
                parts.append(part)
        deciding = " … ".join(parts)
        if fid.startswith("decline.") and fid != "decline.never_mind":
            deciding = " ".join(msg.split()[:6]).rstrip("?.!,;:")
        return msg, deciding, t


def reading(fid: str, deciding: str) -> str:
    q = f'"{deciding}" = ' if deciding else ""
    r = F[fid]["reading"].replace("{Q}", q)
    return r.replace("( ", "(").replace("= )", ")")
