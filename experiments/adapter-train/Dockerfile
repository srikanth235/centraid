# The one training image: every platform runs `python -m adapter_train train --config JOB` in it, and the owner runs the export and the
# parity step (README, "Runbook") in the same image. NOT BUILT: this file has never been through `docker build`.
#
# Build from the repository root so the native trainer's record reader and llama.cpp pin sit beside this package at the paths the code looks for:
#   docker build -f experiments/adapter-train/Dockerfile --build-arg GIT_COMMIT=$(git rev-parse HEAD) -t adapter-train:$(git rev-parse --short HEAD) .
# (experiments/adapter-train/Dockerfile.dockerignore keeps the context to what is copied below.)
FROM pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime
ARG GIT_COMMIT
RUN test -n "$GIT_COMMIT" || (echo "build with --build-arg GIT_COMMIT=<commit>" && false)
ENV CENTRAID_GIT_COMMIT=$GIT_COMMIT PYTHONUNBUFFERED=1 HF_HOME=/tmp/hf LLAMA_CPP_DIR=/opt/llama.cpp
# git: the export step clones llama.cpp at the pinned commit (below, at build time, so a job needs no GitHub at run time).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY experiments/adapter-train/requirements.txt /app/experiments/adapter-train/requirements.txt
RUN pip install --no-cache-dir -r /app/experiments/adapter-train/requirements.txt
COPY experiments/adapter-train/adapter_train /app/experiments/adapter-train/adapter_train
COPY experiments/toolchat/native/train/datagen.py experiments/toolchat/native/train/to_gguf.py /app/experiments/toolchat/native/train/
# The converter's tree at the pinned commit (to_gguf.LLAMA_CPP_COMMIT; never master). The build fails if the checkout is not that commit.
RUN python -c "import sys, pathlib; sys.path.insert(0, '/app/experiments/toolchat/native/train'); import to_gguf; t = pathlib.Path('/opt/llama.cpp'); to_gguf.ensure_tree(t); to_gguf.check_tree(t)"
WORKDIR /app/experiments/adapter-train
ENTRYPOINT ["python", "-m", "adapter_train"]
