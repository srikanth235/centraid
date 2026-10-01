"""Thin driver over the real `nativetools` runtime (the only source of observations)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
BIN = Path(os.environ.get("NATIVETOOLS", REPO / "target" / "debug" / "nativetools"))
TOOLS_MODE = os.environ.get("NATIVE_TOOLS_MODE", "sig")     # SPEC §6.0.2: trained models see signature lines


def run(*args: str) -> dict:
    out = subprocess.run([str(BIN), *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"nativetools {args[0]} failed: {out.stderr.strip()}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def seed(world: dict, vault: Path, tmp: Path) -> dict:
    wpath = tmp / (vault.name + ".world.json")
    wpath.write_text(json.dumps(world))
    try:
        return run("seed", str(wpath), str(vault))
    finally:
        wpath.unlink(missing_ok=True)


def copy(vault: Path, new: Path) -> None:
    run("copy", str(vault), str(new))


def remove_vault(vault: Path) -> None:
    for p in vault.parent.glob(vault.name + "*"):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        else:
            p.unlink(missing_ok=True)


class Session:
    """One `nativetools session` process: JSON lines in, JSON lines out."""

    def __init__(self, vault: Path, today: str, me: str, directory: bool = True, preground: bool = True,
                 tools: str = TOOLS_MODE):
        args = [str(BIN), "session", str(vault), "--today", today, "--me", me, "--tools", tools]
        if not directory:
            args.append("--no-directory")
        if not preground:
            args.append("--no-preground")
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, bufsize=1)

    def req(self, obj: dict) -> dict:
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("session died: " + (self.proc.stderr.read() if self.proc.stderr else ""))
        return json.loads(line)

    def prompt(self) -> dict:
        return self.req({"op": "prompt"})

    def user(self, text: str) -> dict:
        return self.req({"op": "user", "text": text})

    def call(self, tool: str, args: dict) -> dict:
        return self.req({"op": "call", "tool": tool, "args": args})

    def call_text(self, text: str) -> dict:
        return self.req({"op": "call_text", "text": text})

    def parse(self, text: str) -> dict:
        return self.req({"op": "parse", "text": text})

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
