"""What every launcher shares: the image, the command, and the rule that nothing is submitted without `--submit`.

A launcher is a thin file: it turns (a job file location, an image, a few platform names) into the platform's own job request, prints it,
and only with `--submit` calls the platform's SDK. Launching a cloud job spends money and is the owner's to do; the tests build requests
and never call an SDK.
"""
from __future__ import annotations

import argparse
import json
import re
import sys

# One image, one command. The image's build sets CENTRAID_GIT_COMMIT (record.py).
COMMAND = ["python", "-m", "adapter_train", "train", "--config"]


def job_name(name: str, suffix: str = "") -> str:
    """A platform job name (letters, digits, hyphens; at most 63 characters) from the job file's name."""
    clean = re.sub(r"[^A-Za-z0-9-]+", "-", name).strip("-")
    return (clean[: 63 - len(suffix) - 1].rstrip("-") + ("-" + suffix if suffix else "")) or "adapter-train"


def need(cond: bool, message: str) -> None:
    if not cond:
        raise SystemExit(message)


def cli(build, submit, argv=None, extra=None):
    """Parse the shared arguments, print `build(args)` as JSON, and call `submit(request, args)` only with --submit."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, help="the job file's location on the platform's storage (s3://, gs:// or a mounted path)")
    ap.add_argument("--image", required=True, help="the training image (registry URI), built from the Dockerfile at a commit")
    ap.add_argument("--submit", action="store_true", help="really start the job (spends money); without it the request is only printed")
    for add in extra or ():
        add(ap)
    args = ap.parse_args(argv)
    request = build(args)
    print(json.dumps(request, indent=1, sort_keys=True))
    if not args.submit:
        print("not submitted (no --submit)", file=sys.stderr)
        return 0
    submit(request, args)
    return 0
