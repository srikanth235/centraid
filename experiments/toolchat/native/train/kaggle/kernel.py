"""The Kaggle kernel of M6 (#1171): train ONE arm on a datagen data version, export a Q4_0 GGUF, score it on val with assist-eval.

NOT RUN. It was written without a GPU and without Kaggle; nothing here has been pushed. See README.md in this folder.

Input: the private dataset `centraid-m6-src` (make_kit.sh): `src.tar.gz` (the repository at the commit that was cut) and `params.json`.
The data version is not an input: it is pulled from the private HF dataset with the Kaggle secret `HF_TOKEN` (never printed, never written).

params.json (make_kit.sh writes it; every key has the default shown):
    arm            "A" | "B" | "C"                       required (train/arms.py)
    data_folder    "datagen/vN"                          required: the folder of the data version inside the HF dataset
    hf_repo        "srikanth235/centraid-native-data"
    hf_revision    null                                  a commit or tag of that dataset; null = main
    epochs         2        bs 16      max_len 8192      train.py flags
    lr             null                                  null = the arm's (arms.py)
    hours          9.0                                   train.py's wall-clock budget; the kernel's own limit is 12 h
    checkpoints    "1.0"                                 fractions at which train.py saves (each is 1.6 GB: keep the list short)
    mark           "final"                               which mark is exported: "final" (FINAL) or "best" (best.json: lowest val decision loss)
    s2_baseline    false                                 also score S2 (`--tools s2`) on the same val; deferred by the owner, so off
    shards         null                                  assist-eval processes; null = one per GPU

Steps: pip install -> pull train.jsonl.zst / val.jsonl.zst / manifest.json (test and noise are NOT downloaded) -> train.py --arm
-> to_gguf.py (--no-mtp, Q4_0, output tensor Q8_0: its own defaults) -> build assist-eval with CUDA -> score val under the default
tools (and S2's GGUF under `--tools s2` when asked) -> arm_report.py.
Output (/kaggle/working): arm-<ARM>.val.json (the report compare_arms.py reads), report-<ARM>.json, summary-<ARM>.txt, the GGUF and its
sidecar, train.log, marks.json / best.json / train_meta.json, run.log. Checkpoints are deleted at the end (disk), the GGUF stays.
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
TMP = "/kaggle/temp"
SRC = os.path.join(TMP, "src")
DEFAULTS = {"hf_repo": "srikanth235/centraid-native-data", "hf_revision": None, "epochs": 2, "bs": 16, "max_len": 8192, "lr": None,
            "hours": 9.0, "checkpoints": "1.0", "mark": "final", "s2_baseline": False, "shards": None}
S2 = {"url": "https://huggingface.co/srikanth235/centraid-native-gguf/resolve/s2-q4_0/centraid-native-s2-Q4_0.gguf",
      "sha256": "b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668"}
os.makedirs(OUT, exist_ok=True)
LOG = open(os.path.join(OUT, "run.log"), "a")


def say(*parts):
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()


def sh(command, check=True, **kw):
    say("$", command)
    return subprocess.run(command, shell=True, check=check, **kw)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def hf_token():
    """The token from the Kaggle secret HF_TOKEN (or the environment, for a run elsewhere). Its value is never logged."""
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret("HF_TOKEN")
    except Exception:  # noqa: BLE001  (not on Kaggle, or the secret is not attached to this kernel)
        token = os.environ.get("HF_TOKEN")
        if not token:
            sys.exit("no HF_TOKEN: attach the Kaggle secret HF_TOKEN to this kernel (Add-ons > Secrets)")
        return token


def load_params():
    hits = glob.glob("/kaggle/input/**/params.json", recursive=True)
    if not hits:
        sys.exit("no params.json under /kaggle/input: attach the dataset centraid-m6-src to this kernel")
    params = {**DEFAULTS, **json.load(open(hits[0]))}
    params["_input"] = os.path.dirname(hits[0])
    for key in ("arm", "data_folder"):
        if not params.get(key):
            sys.exit("params.json needs %r" % key)
    if params["arm"] not in ("A", "B", "C") or params["mark"] not in ("final", "best"):
        sys.exit("params.json: arm is A, B or C; mark is final or best")
    return params


def pull_data(p, token):
    """train.jsonl.zst, val.jsonl.zst and manifest.json of the data version; the held-out test and noise files are not fetched."""
    from huggingface_hub import hf_hub_download, list_repo_files

    got = {}
    for name in ("train.jsonl.zst", "val.jsonl.zst", "manifest.json"):
        got[name] = hf_hub_download(p["hf_repo"], "%s/%s" % (p["data_folder"], name), repo_type="dataset", token=token,
                                    revision=p["hf_revision"], local_dir=os.path.join(TMP, "data"))
    shutil.copy(got["manifest.json"], os.path.join(OUT, "manifest.json"))
    # the world JSON the val sessions name: a `worlds/` folder beside the data, if the version carries one (UNVERIFIED against M4's output)
    prefix = "%s/worlds/" % p["data_folder"]
    worlds = [f for f in list_repo_files(p["hf_repo"], repo_type="dataset", token=token, revision=p["hf_revision"]) if f.startswith(prefix)]
    if not worlds:
        sys.exit("the data version has no %sworlds/*.json: assist-eval cannot seed val without them" % prefix)
    for f in worlds:
        hf_hub_download(p["hf_repo"], f, repo_type="dataset", token=token, revision=p["hf_revision"], local_dir=os.path.join(TMP, "data"))
    return got, os.path.join(TMP, "data", p["data_folder"], "worlds")


def val_plain(val_zst):
    """val as plain JSONL without the render (assist-eval replays sessions; it does not need the token ids)."""
    import io
    import zstandard

    path = os.path.join(TMP, "val.jsonl")
    n = 0
    with open(val_zst, "rb") as raw, zstandard.ZstdDecompressor().stream_reader(raw) as reader, open(path, "w") as out:
        for line in io.TextIOWrapper(reader, encoding="utf-8"):
            if line.strip():
                rec = json.loads(line)
                rec.pop("render", None)
                out.write(json.dumps(rec) + "\n")
                n += 1
    say("val sessions", n)
    return path


def train(p, data, gpus):
    code = os.path.join(SRC, "experiments/toolchat/native/train")
    ckpt = os.path.join(OUT, "ckpt-%s" % p["arm"])
    args = ["--arm", p["arm"], "--train", data["train.jsonl.zst"], "--val", data["val.jsonl.zst"], "--out", ckpt,
            "--epochs", str(p["epochs"]), "--bs", str(p["bs"]), "--max-len", str(p["max_len"]), "--hours", str(p["hours"]),
            "--checkpoints", p["checkpoints"], "--save-every", "200", "--resume"]
    if p["lr"] is not None:
        args += ["--lr", str(p["lr"])]
    env = dict(os.environ, PYTHONUNBUFFERED="1", TOKENIZERS_PARALLELISM="false", PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True",
               HF_TOKEN=hf_token())
    launcher = "torchrun --standalone --nproc_per_node %d" % gpus if gpus > 1 else sys.executable
    sh("%s %s/train.py %s 2>&1 | tee %s/train.log" % (launcher, code, " ".join(args), OUT), env=env, cwd=code, executable="/bin/bash")
    if not os.path.exists(os.path.join(ckpt, "DONE")):
        sys.exit("training did not finish (no DONE in %s): re-run the kernel to resume" % ckpt)
    mark = open(os.path.join(ckpt, "FINAL")).read().strip()
    if p["mark"] == "best":
        best = os.path.join(ckpt, "best.json")
        mark = json.load(open(best))["mark"] if os.path.exists(best) else mark
    for f in ("marks.json", "best.json", "train_meta.json"):
        if os.path.exists(os.path.join(ckpt, f)):
            shutil.copy(os.path.join(ckpt, f), OUT)
    say("exporting mark", mark)
    return os.path.join(ckpt, mark), code


def export(ckpt, code, arm):
    """to_gguf.py does the conversion as the phone's engine needs it: --no-mtp, Q4_0, the output tensor at Q8_0."""
    gguf_dir = os.path.join(OUT, "gguf")
    sh("%s %s/to_gguf.py %s --out %s --name centraid-native-arm%s --llama-cpp %s/llama.cpp"
       % (sys.executable, code, ckpt, gguf_dir, arm, TMP))
    path = os.path.join(gguf_dir, "centraid-native-arm%s-Q4_0.gguf" % arm)
    say("gguf", path, sha256(path))
    return path


def build_eval():
    binary = os.path.join(SRC, "target/release/assist-eval")
    if not os.path.exists(binary):
        if not shutil.which("cargo"):
            sh("curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal")
            os.environ["PATH"] = os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
        sh("cargo build --release -p centraid-assist-eval --features cuda --bin assist-eval", cwd=SRC)
    return binary


def score(binary, gguf, tools, tag, val, worlds, gpus, shards):
    """assist-eval on val, one process per shard, then one report from all the shards. Returns the report path."""
    shards = shards or max(1, gpus)
    procs = []
    for k in range(shards):
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(k % max(1, gpus)))
        cmd = [binary, "--model", gguf, "--gpu-layers", "999", "--threads", "2", "--resume", "--shard", "%d/%d" % (k, shards), "--set", val,
               "--worlds", worlds, "--out", os.path.join(OUT, "%s-shard-%d" % (tag, k))] + (["--tools", tools] if tools else [])
        say("$", " ".join(cmd))
        procs.append(subprocess.Popen(cmd, env=env, stdout=open(os.path.join(OUT, "log-%s-%d.txt" % (tag, k)), "a"), stderr=subprocess.STDOUT))
    codes = [pr.wait() for pr in procs]
    say("shard exit codes", codes)
    files = sorted(glob.glob(os.path.join(OUT, "%s-shard-*.sessions.jsonl" % tag)))
    label = "gguf:%s[tools=%s]" % (sha256(gguf)[:12], tools or "sig")
    report = os.path.join(OUT, "report-%s" % tag)
    sh("%s --label '%s' --rescore %s --set %s --worlds %s --out %s > %s/summary-%s.txt"
       % (binary, label, " ".join(files), val, worlds, report, OUT, tag))
    if any(codes):
        sys.exit("a scoring shard failed: %s" % codes)
    return report + ".json"


def main():
    p = load_params()
    say("params", json.dumps({k: v for k, v in p.items() if not k.startswith("_")}))
    os.environ["PATH"] = "/usr/local/cuda/bin:" + os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
    for tool in ("nvidia-smi -L", "nvcc --version", "cmake --version"):
        sh(tool, check=False)
    gpus = len(subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout.strip().splitlines())
    if not gpus:
        sys.exit("no GPU: turn the accelerator on for this kernel")
    if not os.path.isdir(SRC):
        os.makedirs(SRC)
        sh("tar -xzf %s/src.tar.gz -C %s" % (p["_input"], SRC))
    # `peft` for arm C, `zstandard` for the data, the transformers version train/bundle.py stages; the fused linear-attention kernels
    # are optional (the trainer falls back to the PyTorch reference, which is slow): a failed install is logged, not fatal
    sh("pip install -q transformers==5.17.0 peft zstandard huggingface_hub safetensors sentencepiece pyyaml requests")
    sh("pip install -q flash-linear-attention causal-conv1d", check=False)
    token = hf_token()
    data, worlds = pull_data(p, token)
    val = val_plain(data["val.jsonl.zst"])
    ckpt, code = train(p, data, gpus)
    gguf = export(ckpt, code, p["arm"])
    for d in glob.glob(os.path.join(OUT, "ckpt-*")):  # the checkpoints are 1.6 GB each and the GGUF is what is kept
        shutil.rmtree(d, ignore_errors=True)
    binary = build_eval()
    reports = [(p["arm"], score(binary, gguf, None, p["arm"], val, worlds, gpus, p["shards"]), "sig")]
    if p["s2_baseline"]:
        s2 = os.path.join(OUT, "s2.gguf")
        urllib.request.urlretrieve(S2["url"], s2)
        if sha256(s2) != S2["sha256"]:
            sys.exit("the S2 file is not the one this kernel names (sha256)")
        reports.append(("S2", score(binary, s2, "s2", "S2", val, worlds, gpus, p["shards"]), "s2"))
        os.remove(s2)
    kit = os.path.join(SRC, "experiments/toolchat/native/train/kaggle")
    for arm, report, tools in reports:
        sh("%s %s/arm_report.py %s --arm %s --tools %s --out %s/arm-%s.val.json" % (sys.executable, kit, report, arm, tools, OUT, arm))
    say("done: compare with `python3 compare_arms.py arm-A.val.json arm-B.val.json arm-C.val.json [arm-S2.val.json]`")


main()
