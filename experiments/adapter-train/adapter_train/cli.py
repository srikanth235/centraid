"""`train --config job.json`: the one command every launcher runs.

    python -m adapter_train train --config JOB     # JOB is a path, s3:// or gs:// object
    python -m adapter_train check --config JOB     # validate the job file and print what it resolves to; reads no data, loads no model

SIGTERM (a Spot reclaim, a platform's stop) asks the run to checkpoint at the next step and exit 0, so the platform's restart resumes.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import tempfile
import threading
from pathlib import Path

from . import config, storage


def read_job(where: str, scratch) -> config.Job:
    text = storage.read_text(where, scratch) if "://" in where or Path(where).exists() else None
    if text is None:
        raise config.ConfigError("no job file at %s" % where)
    return config.loads(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="adapter_train")
    ap.add_argument("command", choices=("train", "check"))
    ap.add_argument("--config", required=True)
    ap.add_argument("--workdir", default=None, help="local scratch (default: a temporary directory)")
    a = ap.parse_args(argv)
    work = Path(a.workdir) if a.workdir else Path(tempfile.mkdtemp(prefix="adapter-train-"))
    work.mkdir(parents=True, exist_ok=True)
    try:
        job = read_job(a.config, work)
    except config.ConfigError as e:
        print("job file: %s" % e, file=sys.stderr)
        return 2
    if a.command == "check":
        print(json.dumps({"name": job.name, "digest": job.digest(), "targets": list(job.lora.targets),
                          "target_regex": config.target_regex(job.lora.targets), "steps": job.schedule.steps}, indent=1))
        return 0
    from . import trainer

    halt = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: halt.set())
    result = trainer.run(job, work, stop=halt.is_set)
    print(json.dumps({k: v for k, v in result.items() if k != "adapted_modules"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
