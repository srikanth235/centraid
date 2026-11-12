"""GCP: a Vertex AI custom job on Spot VMs, one GPU.

    python -m launchers.gcp --config gs://BUCKET/run/job.json --image REGION-docker.pkg.dev/PROJECT/REPO/adapter-train:COMMIT \
        --project PROJECT [--region us-central1] [--machine g2-standard-8 --accelerator NVIDIA_L4] [--submit]

Vertex AI has no A10G; the nearest 24 GB card is the L4 (`g2-standard-8`), and `NVIDIA_TESLA_A100` is the larger choice. `SPOT` with
`restartJobOnWorkerRestart` reruns the container after a preemption and the container resumes from the checkpoints under the job
file's gs:// `checkpoints`. The service account the job runs as needs read and write on the buckets of the job file.
"""
from __future__ import annotations

from . import common


def request(args) -> dict:
    common.need(args.config.startswith("gs://"), "--config must be a gs:// object on GCP")
    return {
        "displayName": common.job_name(args.name, args.suffix),
        "jobSpec": {
            "workerPoolSpecs": [{
                "machineSpec": {"machineType": args.machine, "acceleratorType": args.accelerator, "acceleratorCount": 1},
                "replicaCount": 1,
                "diskSpec": {"bootDiskType": "pd-ssd", "bootDiskSizeGb": args.volume_gb},
                "containerSpec": {"imageUri": args.image, "command": common.COMMAND[:3], "args": [*common.COMMAND[3:], args.config]},
            }],
            "scheduling": {"strategy": "SPOT", "restartJobOnWorkerRestart": True, "timeout": "%ds" % int(args.max_hours * 3600)},
        },
    }


def submit(req, args):
    import json  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(req, fh)
    subprocess.run(["gcloud", "ai", "custom-jobs", "create", "--project", args.project, "--region", args.region,
                    "--display-name", req["displayName"], "--config", fh.name], check=True)


def extras():
    def add(ap):
        ap.add_argument("--project", required=True)
        ap.add_argument("--region", default="us-central1")
        ap.add_argument("--machine", default="g2-standard-8")
        ap.add_argument("--accelerator", default="NVIDIA_L4")
        ap.add_argument("--name", default="adapter-train")
        ap.add_argument("--suffix", default="")
        ap.add_argument("--max-hours", type=float, default=8.0)
        ap.add_argument("--volume-gb", type=int, default=100)

    return [add]


if __name__ == "__main__":
    raise SystemExit(common.cli(request, submit, extra=extras()))
