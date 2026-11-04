"""The Kaggle kernel of the eval: build assist-eval with CUDA llama.cpp, fetch the model, score val, write the report.

Input: the private dataset `centraid-assist-eval-input` (make_bundle.sh): src.tar.gz, val.jsonl, worlds/, kit.json. No token is
needed or read: the data came in with the dataset, and the model is a public file (or a second private dataset).
Output (/kaggle/working): report.json, sessions-*.jsonl (one per shard), log-*.txt, kit.json, run.log. A shard that stops can
be run again with the same output directory: `--resume` skips the sessions already in its file.
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request

OUT = "/kaggle/working"
BUILD = "/kaggle/temp/build"
LOG = open(os.path.join(OUT, "run.log"), "a")


def say(*parts):
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


def sh(command, **kw):
    say("$", command)
    subprocess.run(command, shell=True, check=True, **kw)


def find_input():
    hits = glob.glob("/kaggle/input/**/kit.json", recursive=True)
    if not hits:
        sys.exit("no kit.json under /kaggle/input: attach the dataset centraid-assist-eval-input to this kernel")
    return os.path.dirname(hits[0])


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    inp = find_input()
    kit = json.load(open(os.path.join(inp, "kit.json")))
    shutil.copy(os.path.join(inp, "kit.json"), OUT)
    say("kit", json.dumps(kit))
    # a failed first CUDA build should say why
    os.environ["PATH"] = "/usr/local/cuda/bin:" + os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
    for tool in ("nvidia-smi -L", "nvcc --version", "cmake --version"):
        sh(tool)
    # a stopped run's session files, put beside the input as a dataset, are picked up by --resume
    for old in glob.glob(os.path.join(inp, "shard-*.sessions.jsonl")):
        shutil.copy(old, OUT)
    gpus = len(subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout.strip().splitlines())

    # the model: a public file, or a file of a second attached dataset
    model = kit["model"]
    gguf = os.path.join(OUT, "model.gguf")
    if "url" in model:
        if not os.path.exists(gguf):
            urllib.request.urlretrieve(model["url"], gguf)
    else:
        shutil.copy(os.path.join(inp, model["input"]), gguf)
    if "sha256" in model and sha256(gguf) != model["sha256"]:
        sys.exit("the model file is not the one the kit names (sha256)")
    say("model", sha256(gguf))

    # the build: the repository at the commit the bundle was cut from, Rust from rustup, llama.cpp with CUDA
    if not os.path.exists(os.path.join(BUILD, "target/release/assist-eval")):
        os.makedirs(BUILD, exist_ok=True)
        sh(f"tar -xzf {inp}/src.tar.gz -C {BUILD}")
        if not shutil.which("cargo"):
            sh("curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal")
            os.environ["PATH"] = os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
        sh("cargo build --release -p centraid-assist-eval --features cuda --bin assist-eval", cwd=BUILD)
    binary = os.path.join(BUILD, "target/release/assist-eval")

    # the run: one process per GPU, each its own shard, all resumable
    shards = int(kit.get("shards", max(1, gpus)))
    worlds = os.path.join(inp, "worlds")
    procs = []
    for k in range(shards):
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(k % max(1, gpus)))
        cmd = [binary, "--model", gguf, "--tools", model["tools"], "--gpu-layers", "999", "--threads", "2", "--resume",
               "--shard", f"{k}/{shards}", "--set", os.path.join(inp, "val.jsonl"), "--worlds", worlds,
               "--out", os.path.join(OUT, f"shard-{k}")]
        say("$", " ".join(cmd))
        procs.append(subprocess.Popen(cmd, env=env, stdout=open(os.path.join(OUT, f"log-{k}.txt"), "a"), stderr=subprocess.STDOUT))
    codes = [p.wait() for p in procs]
    say("shard exit codes", codes)

    # the report: every shard's sessions, scored as one
    files = sorted(glob.glob(os.path.join(OUT, "shard-*.sessions.jsonl")))
    label = f"gguf:{model.get('sha256', sha256(gguf))[:12]}[tools={model['tools']}]"
    sh(f"{binary} --label '{label}' --rescore {' '.join(files)} --set {inp}/val.jsonl --worlds {worlds} --out {OUT}/report > {OUT}/summary.txt")
    print(open(os.path.join(OUT, "summary.txt")).read())
    sys.exit(0 if all(c == 0 for c in codes) else 1)


main()
