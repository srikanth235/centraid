"""AWS: a SageMaker training job on managed Spot, one A10G (`ml.g5.xlarge`), us-east-1.

    python -m launchers.sagemaker --config s3://BUCKET/run/job.json --image ACCT.dkr.ecr.us-east-1.amazonaws.com/adapter-train:COMMIT \
        --role arn:aws:iam::ACCT:role/NAME [--instance ml.g5.xlarge] [--submit]

Managed Spot: SageMaker restarts an interrupted job on a new instance and the container resumes from the newest complete checkpoint under the
job file's `checkpoints`, which the storage layer reads from S3 itself, so no `CheckpointConfig` is set (SageMaker's own `/opt/ml/checkpoints`
sync would be a second copy of the same files). The job file's locations are s3:// URIs of buckets the role can read and write.
"""
from __future__ import annotations

from . import common

REGION = "us-east-1"
INSTANCE = "ml.g5.xlarge"  # one NVIDIA A10G, 24 GB
SPOT_WAIT_FACTOR = 2


def request(args) -> dict:
    common.need(args.config.startswith("s3://"), "--config must be an s3:// object on AWS")
    common.need(args.role.startswith("arn:aws:iam::"), "--role must be an IAM role ARN")
    common.need(".dkr.ecr." in args.image or args.image.startswith("public.ecr.aws/"), "--image must be an ECR image")
    max_run = int(args.max_hours * 3600)
    req = {
        "TrainingJobName": common.job_name(args.name, args.suffix),
        "RoleArn": args.role,
        "AlgorithmSpecification": {
            "TrainingImage": args.image,
            "TrainingInputMode": "File",
            "ContainerEntrypoint": common.COMMAND[:3],
            "ContainerArguments": [*common.COMMAND[3:], args.config],
        },
        "ResourceConfig": {"InstanceType": args.instance, "InstanceCount": 1, "VolumeSizeInGB": args.volume_gb},
        "StoppingCondition": {"MaxRuntimeInSeconds": max_run, "MaxWaitTimeInSeconds": max_run * SPOT_WAIT_FACTOR},
        "EnableManagedSpotTraining": True,
        "OutputDataConfig": {"S3OutputPath": args.config.rsplit("/", 1)[0] + "/sagemaker-output/"},
        "EnableNetworkIsolation": False,
        "RetryStrategy": {"MaximumRetryAttempts": 1},
        "Tags": [{"Key": "project", "Value": "centraid-adapter-train"}],
    }
    if args.hf_secret:
        # The id of the secret, never the token: DescribeTrainingJob shows Environment in plain. The container reads the token itself, with the role.
        req["Environment"] = {"HF_TOKEN_SECRET_ID": args.hf_secret}
    return req


def submit(req, args):
    import boto3  # noqa: PLC0415 - only a real submission needs the SDK

    boto3.client("sagemaker", region_name=REGION).create_training_job(**req)


def extras():
    def add(ap):
        ap.add_argument("--role", required=True)
        ap.add_argument("--instance", default=INSTANCE)
        ap.add_argument("--name", default="adapter-train")
        ap.add_argument("--suffix", default="", help="appended to the job name (SageMaker names are unique per region)")
        ap.add_argument("--max-hours", type=float, default=8.0)
        ap.add_argument("--volume-gb", type=int, default=50)
        ap.add_argument("--hf-secret", default=None, help="Secrets Manager secret id/ARN holding the Hugging Face token (the role needs secretsmanager:GetSecretValue on it)")

    return [add]


if __name__ == "__main__":
    raise SystemExit(common.cli(request, submit, extra=extras()))
