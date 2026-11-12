"""Modal: the same image and the same command on an A10G. UNTESTED: never run, and `modal` is not even installed where this was written.

    modal run launchers/modal_app.py --config s3://BUCKET/run/job.json --image REGISTRY/adapter-train:COMMIT

Needs the `modal` package and a Modal secret named `adapter-train-storage` holding the credentials of the job file's buckets
(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or GOOGLE_APPLICATION_CREDENTIALS_JSON). `modal run` is the launch: nothing here runs until
the owner types it. Modal retries a preempted function; the container resumes from the job file's `checkpoints`.
"""
import subprocess

import modal

app = modal.App("adapter-train")


def _image(ref: str) -> modal.Image:
    return modal.Image.from_registry(ref)


@app.local_entrypoint()
def main(config: str, image: str, hours: int = 8):
    @app.function(image=_image(image), gpu="A10G", timeout=hours * 3600, retries=modal.Retries(max_retries=5, backoff_coefficient=1.0, initial_delay=5.0),
                  secrets=[modal.Secret.from_name("adapter-train-storage")], serialized=True)
    def train(config_location: str):
        subprocess.run(["python", "-m", "adapter_train", "train", "--config", config_location], check=True)

    with app.run():
        train.remote(config)
