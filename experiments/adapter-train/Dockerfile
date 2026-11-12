# The one training image: every platform runs `python -m adapter_train train --config JOB` in it.
# Build from the repository root so the native trainer's record reader is beside this package at the path trainer.py looks for:
#   docker build -f experiments/adapter-train/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t adapter-train:$(git rev-parse --short HEAD) .
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
ARG GIT_COMMIT
RUN test -n "$GIT_COMMIT" || (echo "build with --build-arg GIT_COMMIT=<commit>" && false)
ENV CENTRAID_GIT_COMMIT=$GIT_COMMIT PYTHONUNBUFFERED=1 HF_HOME=/tmp/hf
WORKDIR /app
COPY experiments/adapter-train/requirements.txt /app/experiments/adapter-train/requirements.txt
RUN pip install --no-cache-dir -r /app/experiments/adapter-train/requirements.txt
COPY experiments/adapter-train/adapter_train /app/experiments/adapter-train/adapter_train
COPY experiments/toolchat/native/train/datagen.py /app/experiments/toolchat/native/train/datagen.py
WORKDIR /app/experiments/adapter-train
ENTRYPOINT ["python", "-m", "adapter_train"]
