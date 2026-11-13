"""The Kaggle kernel that SCORES a model: nothing trains here.

It fetches the stock base GGUF by its pinned URL and sha256, an optional adapter, and the val split of one data version
by tag and by the hash its manifest records; builds `assist-eval` with CUDA llama.cpp; replays the reference calls (the
precondition: the set must replay to 100% or nothing is scored); scores; writes the report. The first intended run is
the baseline: the stock model, no adapter.

Input: the private dataset `centraid-assist-eval-input` (make_bundle.sh): `src.tar.gz` (the repository at one commit),
`kit.json`, and an adapter file when the kit names one by `input`. The data version is private: the kernel reads it from
the Hugging Face dataset with a Kaggle secret `HF_TOKEN` (attach it to the kernel by hand; it is read here and never
written to any file or log).
Output (/kaggle/working): report.json, summary.txt, shard-*.sessions.jsonl and shard-*.config.json, kit.json, run.log,
log-*.txt. A shard that stops runs again with the same output directory: `--resume` skips what its file holds.
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
DATA = "/kaggle/temp/data"
VAL = "data/val.jsonl.zst"


def say(*parts):
    line = " ".join(str(p) for p in parts)
    print(line, flush=True)
    try:
        with open(os.path.join(OUT, "run.log"), "a") as log:
            log.write(line + "\n")
    except OSError:
        pass


def sh(command, **kw):
    say("$", command)
    subprocess.run(command, shell=True, check=True, **kw)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def blake3_bytes(data):
    import blake3  # pip install blake3: the hash the manifest uses

    return blake3.blake3(data).hexdigest()


def check_manifest_pin(manifest, pin):
    """The val file the kit pins is the one the manifest at the tag describes. Returns None, or what is wrong."""
    entry = (manifest.get("files") or {}).get(VAL)
    if entry is None:
        return f"the manifest has no {VAL}"
    if entry.get("blake3") != pin:
        return f"the manifest's {VAL} is blake3 {entry.get('blake3')}, the kit pins {pin}"
    return None


def fetch(url, dest, token=None):
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(request) as reply, open(dest, "wb") as out:
        shutil.copyfileobj(reply, out)


def fetch_checked(spec, dest, inp):
    """A model or an adapter: by URL or from the input dataset, and always by sha256."""
    if "url" in spec:
        if not os.path.exists(dest):
            fetch(spec["url"], dest)
    else:
        shutil.copy(os.path.join(inp, spec["input"]), dest)
    got = sha256_file(dest)
    if got != spec["sha256"]:
        sys.exit(f"{os.path.basename(dest)} is not the file the kit pins: sha256 {got}, wanted {spec['sha256']}")
    say(os.path.basename(dest), "sha256", got)


def hf_token():
    try:
        from kaggle_secrets import UserSecretsClient

        return UserSecretsClient().get_secret("HF_TOKEN")
    except Exception as error:  # noqa: BLE001 - say why, never the token
        sys.exit(f"no Kaggle secret HF_TOKEN attached to this kernel ({type(error).__name__}): the data version is private")


def fetch_val(data):
    """val of the data version at the tag, checked against its manifest and the kit's pin; plain JSONL and the worlds."""
    import zstandard

    base = f"https://huggingface.co/datasets/{data['repo']}/resolve/{data['tag']}"
    token = hf_token()
    os.makedirs(os.path.join(DATA, "worlds"), exist_ok=True)
    manifest_path = os.path.join(DATA, "manifest.json")
    fetch(f"{base}/manifest.json", manifest_path, token)
    manifest = json.load(open(manifest_path))
    wrong = check_manifest_pin(manifest, data["blake3"])
    if wrong:
        sys.exit(wrong)
    raw = os.path.join(DATA, "val.jsonl.zst")
    fetch(f"{base}/{VAL}", raw, token)
    blob = open(raw, "rb").read()
    if blake3_bytes(blob) != data["blake3"]:
        sys.exit("the downloaded val file does not match the hash its manifest records")
    say("val", data["tag"], "blake3", data["blake3"], "sha256", hashlib.sha256(blob).hexdigest())
    text = zstandard.ZstdDecompressor().stream_reader(open(raw, "rb")).read().decode()
    val = os.path.join(DATA, "val.jsonl")
    open(val, "w").write(text)
    worlds = sorted({json.loads(line)["world"] for line in text.splitlines() if line.strip()})
    for world in worlds:
        fetch(f"{base}/worlds/{world}.json", os.path.join(DATA, "worlds", f"{world}.json"), token)
    say("val sessions", sum(1 for line in text.splitlines() if line.strip()), "worlds", len(worlds))
    return val, os.path.join(DATA, "worlds")


def find_input():
    hits = glob.glob("/kaggle/input/**/kit.json", recursive=True)
    if not hits:
        sys.exit("no kit.json under /kaggle/input: attach the dataset centraid-assist-eval-input to this kernel")
    return os.path.dirname(hits[0])


def main():
    inp = find_input()
    kit = json.load(open(os.path.join(inp, "kit.json")))
    shutil.copy(os.path.join(inp, "kit.json"), OUT)
    say("kit", json.dumps(kit))
    os.environ["PATH"] = "/usr/local/cuda/bin:" + os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
    for tool in ("nvidia-smi -L", "nvcc --version", "cmake --version"):
        sh(tool)
    # a stopped run's files, put beside the input as a dataset, are picked up by --resume
    for old in glob.glob(os.path.join(inp, "shard-*.sessions.jsonl")) + glob.glob(os.path.join(inp, "shard-*.config.json")):
        shutil.copy(old, OUT)
    gpus = len(subprocess.run("nvidia-smi -L", shell=True, capture_output=True, text=True).stdout.strip().splitlines())

    gguf = os.path.join(OUT, "model.gguf")
    fetch_checked(kit["model"], gguf, inp)
    adapter = None
    if kit.get("adapter"):
        adapter = os.path.join(OUT, "adapter.gguf")
        fetch_checked(kit["adapter"], adapter, inp)

    val, worlds = fetch_val(kit["data"])

    if not os.path.exists(os.path.join(BUILD, "target/release/assist-eval")):
        os.makedirs(BUILD, exist_ok=True)
        sh(f"tar -xzf {inp}/src.tar.gz -C {BUILD}")
        if not shutil.which("cargo"):
            sh("curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal")
            os.environ["PATH"] = os.path.expanduser("~/.cargo/bin") + ":" + os.environ["PATH"]
        sh("cargo build --release -p centraid-assist-eval --features cuda --bin assist-eval", cwd=BUILD)
    binary = os.path.join(BUILD, "target/release/assist-eval")
    tools = ["--tools", kit["tools"]]
    grammar = ["--grammar", kit["grammar"]] if kit.get("grammar") else []  # absent: the phone's

    # THE PRECONDITION: the reference calls replay to 100% through the same runner and judge, or nothing is scored
    code = subprocess.run([binary, "replay", "--set", val, "--worlds", worlds, *tools]).returncode
    if code != 0:
        sys.exit("the reference calls do not replay to the gold (listed above): no model was asked")

    shards = int(kit.get("shards", max(1, gpus)))
    procs = []
    for k in range(shards):
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(k % max(1, gpus)))
        cmd = [binary, "--model", gguf, *tools, *grammar, "--gpu-layers", "999", "--threads", "2", "--resume",
               "--shard", f"{k}/{shards}", "--set", val, "--worlds", worlds, "--out", os.path.join(OUT, f"shard-{k}")]
        if adapter:
            cmd += ["--adapter", adapter]
        say("$", " ".join(cmd))
        procs.append(subprocess.Popen(cmd, env=env, stdout=open(os.path.join(OUT, f"log-{k}.txt"), "a"), stderr=subprocess.STDOUT))
    codes = [p.wait() for p in procs]
    say("shard exit codes", codes)
    if any(codes):
        sys.exit(f"a shard failed: see log-*.txt ({codes})")

    # the report: every shard's sessions scored as one, under the settings their .config.json files agree on
    files = sorted(glob.glob(os.path.join(OUT, "shard-*.sessions.jsonl")))
    sh(f"{binary} --rescore {' '.join(files)} --set {val} --worlds {worlds} --out {OUT}/report > {OUT}/summary.txt")
    print(open(os.path.join(OUT, "summary.txt")).read())


if __name__ == "__main__":
    main()
