"""Run a train+score job on a Kaggle GPU and pull the results back.

    kgl.py push <job> --train t.jsonl [--val v.jsonl] [--epochs 3 --lr 5e-5 --bs 4]
                      --score dev90=suite:ids.json [--score holdout=holdout:all]
                      [--trainer ft_final.py] [--search ranked] [--no-snap]
                      [--max-steps N] [--keep-ckpt] [--model M] [--think]
                      [--trainer-args "--offload-embed ..."] [--pin STAGE/<job>/data]
                      [--valscore gold.json --vs-core core.py --vs-ranker ranker.py --vs-onto onto.json
                       [--vs-script valscore.py] [--vs-worlds DIR] [--vs-slices val.jsonl]]
    kgl.py status <job>
    kgl.py pull <job>          # -> $KGL_OUT/<job>/ (run.log, train.log, *.score.log, *.turns.jsonl)
    kgl.py wait <job>          # poll until done, then pull

Needs the kaggle CLI authenticated (~/.kaggle/access_token). One private
dataset (centraid-<job>) + one private kernel (centraid-<job>-run) per job.
"""
import argparse, hashlib, json, os, shlex, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TOOLCHAT = os.path.dirname(HERE)
REPO = os.path.normpath(os.path.join(TOOLCHAT, "..", ".."))
STAGE = os.environ.get("KGL_STAGE", "/tmp/kgl")
OUT = os.environ.get("KGL_OUT", os.path.join(STAGE, "out"))
KAGGLE = os.environ.get("KAGGLE_BIN", "kaggle")
# --pin DIR takes these from a staged bundle instead of the repo (target/release may be mid-rebuild)
PINNED = ("tool-loop", "ld-linux-x86-64.so.2", "libc.so.6", "libm.so.6", "libgcc_s.so.1",
          "suite.json", "holdout.json", "exec.rs")


def user():
    r = subprocess.run([KAGGLE, "config", "view"], capture_output=True, text=True)
    for line in r.stdout.splitlines():
        if "username:" in line:
            return line.split(":", 1)[1].strip()
    sys.exit("kaggle CLI not authenticated")


def run(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    if check and r.returncode:
        sys.exit("%s\n%s" % (" ".join(cmd), out))
    return out


def slug(job):
    return "centraid-" + job.replace("_", "-").lower()


def push(a):
    u, s = ("local" if a.dry else user()), slug(a.job)
    ds = os.path.join(STAGE, a.job, "data"); kd = os.path.join(STAGE, a.job, "kernel")
    shutil.rmtree(os.path.join(STAGE, a.job), ignore_errors=True)
    os.makedirs(ds); os.makedirs(kd)
    if not (a.pin and os.path.exists(os.path.join(a.pin, "tool-loop"))):
        shutil.copy(os.path.join(REPO, "target", "release", "tool-loop"), ds)
    # Kaggle's image has an older glibc: ship the scorer's own loader and libs
    for f in ("/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/libc.so.6",
              "/lib/x86_64-linux-gnu/libm.so.6", "/lib/x86_64-linux-gnu/libgcc_s.so.1"):
        shutil.copy(os.path.realpath(f), os.path.join(ds, os.path.basename(f)))  # uploads are flat
    for c in ("suite.json", "holdout.json"):
        shutil.copy(os.path.join(REPO, "crates", "evalsuite", c), ds)
    for f in ("agent.py", "ft_chat.py", "toolslice.py"):
        shutil.copy(os.path.join(TOOLCHAT, f), ds)
    job = {"bs": a.bs, "lr": a.lr, "epochs": a.epochs, "model": a.model, "score": {},
           "keep_ckpt": a.keep_ckpt, "max_steps": a.max_steps, "lora": a.lora, "search": a.search,
           "n": a.n, "max_len": a.max_len}
    if a.think:   # traced checkpoints: every agent scoring call generates with --think (absent: off)
        job["think"] = True
    if a.fast_kernels:  # Qwen3.5 linear-attention layers: try the fused kernels (absent: off)
        job["fast_kernels"] = True
    if a.trainer:  # e.g. ft_final.py: unpadded, val loss per half epoch
        shutil.copy(a.trainer, ds); job["trainer"] = os.path.basename(a.trainer)
        if a.trainer_args:   # passed through verbatim, e.g. "--offload-embed --tied-inplace"
            job["trainer_args"] = shlex.split(a.trainer_args)
    for key in ("train", "val"):
        p = getattr(a, key)
        if p:
            shutil.copy(p, os.path.join(ds, key + ".jsonl")); job[key] = key + ".jsonl"
    for spec in a.score:   # name=[corpus:]ids.json|all
        name, path = spec.split("=", 1)
        corpus, path = path.split(":", 1) if ":" in path else ("suite", path)
        job["score"][name] = {"corpus": corpus, "snap": not a.no_snap}
        if path != "all":
            shutil.copy(path, os.path.join(ds, name + ".ids.json"))
            job["score"][name]["sessions"] = name + ".ids.json"
    if a.valscore:  # in-distribution val accuracy: valscore.py + its core (scratchpad final3)
        # the script defaults to the valscore.py next to the gold; --vs-script ships another
        script = a.vs_script or os.path.join(os.path.dirname(os.path.abspath(a.valscore)), "valscore.py")
        shutil.copy(script, os.path.join(ds, "valscore.py"))
        for f in (a.vs_core, a.vs_ranker, a.vs_onto,
                  os.path.join(REPO, "crates", "candidates", "src", "exec.rs")):
            shutil.copy(f, ds)
        shutil.copy(a.valscore, os.path.join(ds, "valgold.json"))
        G = json.load(open(a.valscore))
        worlds = a.vs_worlds or os.path.join(TOOLCHAT, "v8", "worlds")   # a held-out world lives elsewhere
        for w in sorted({s["world"] for s in G}):
            shutil.copy(os.path.join(worlds, w + ".json"), ds)
        job["valscore"] = {"gold": "valgold.json", "worlds": sorted({s["world"] for s in G}), "n": a.vs_n}
        if a.vs_slices:   # id -> slice (and scored turns) when the gold itself does not carry them
            shutil.copy(a.vs_slices, os.path.join(ds, "valslices.jsonl"))
            job["valscore"]["slices"] = "valslices.jsonl"
    if a.pin:   # the scorer and its corpus exactly as an earlier staged bundle had them
        for f in PINNED:
            if os.path.exists(os.path.join(a.pin, f)):
                shutil.copy(os.path.join(a.pin, f), os.path.join(ds, f))
    print("tool-loop sha256", hashlib.sha256(open(os.path.join(ds, "tool-loop"), "rb").read()).hexdigest())
    json.dump(job, open(os.path.join(ds, "job.json"), "w"), indent=1)
    json.dump({"title": s, "id": "%s/%s" % (u, s), "licenses": [{"name": "other"}]},
              open(os.path.join(ds, "dataset-metadata.json"), "w"))
    if a.dry:   # stage only: a local run of run.py over this directory is the smoke test
        print("staged", ds); return
    exists = subprocess.run([KAGGLE, "datasets", "status", "%s/%s" % (u, s)], capture_output=True).returncode == 0
    print(run([KAGGLE, "datasets", "version", "-p", ds, "-m", a.job] if exists
              else [KAGGLE, "datasets", "create", "-p", ds]))
    for _ in range(60):
        st = run([KAGGLE, "datasets", "status", "%s/%s" % (u, s)], check=False)
        if "ready" in st.lower():
            break
        time.sleep(10)
    shutil.copy(os.path.join(HERE, "run.py"), kd)
    json.dump({"id": "%s/%s-run" % (u, s), "title": s + "-run", "code_file": "run.py", "language": "python",
               "kernel_type": "script", "is_private": True, "enable_gpu": True,
               "enable_internet": True, "machine_shape": a.machine,
               "dataset_sources": ["%s/%s" % (u, s)], "competition_sources": [], "kernel_sources": []},
              open(os.path.join(kd, "kernel-metadata.json"), "w"), indent=1)
    print(run([KAGGLE, "kernels", "push", "-p", kd]))


def status(a):
    out = run([KAGGLE, "kernels", "status", "%s/%s-run" % (user(), slug(a.job))], check=False)
    print(out)
    return out


def pull(a):
    d = os.path.join(OUT, a.job)
    os.makedirs(d, exist_ok=True)
    print(run([KAGGLE, "kernels", "output", "%s/%s-run" % (user(), slug(a.job)), "-p", d, "-o"], check=False)[-2000:])
    for f in sorted(os.listdir(d)):
        if f.endswith(".score.log"):
            print("==", f); os.system("grep -E 'SESSIONS|TURNS|right|asked|wrong' %s | tail -8" % os.path.join(d, f))


def wait(a):
    while True:
        st = status(a).lower()
        if "complete" in st or "error" in st or "cancel" in st:
            break
        time.sleep(a.every)
    pull(a)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["push", "status", "pull", "wait"])
    ap.add_argument("job")
    ap.add_argument("--train"); ap.add_argument("--val")
    ap.add_argument("--epochs", type=int, default=3); ap.add_argument("--lr", type=float, default=5e-5)
    ap.add_argument("--bs", type=int, default=4); ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--model", default="ibm-granite/granite-4.0-350m")
    ap.add_argument("--score", action="append", default=[], help="name=ids.json")
    ap.add_argument("--lora", type=int, default=0)
    ap.add_argument("--trainer", help="a trainer script to ship and run instead of ft_chat.py")
    ap.add_argument("--trainer-args", default="", help="extra flags for --trainer, one string")
    ap.add_argument("--pin", help="a staged bundle's data dir: take the scorer binary, libs and corpora from it")
    ap.add_argument("--search", default="ranked", choices=["ranked", "plain"])
    ap.add_argument("--n", type=int, default=0); ap.add_argument("--max-len", type=int, default=0)
    ap.add_argument("--valscore", help="gold.json from valscore.py gold: score the val sessions in-job")
    ap.add_argument("--vs-core"); ap.add_argument("--vs-ranker"); ap.add_argument("--vs-onto")
    ap.add_argument("--vs-n", type=int, default=0, help="val sessions to score (0: all)")
    ap.add_argument("--vs-script", help="the valscore.py to ship (default: the one next to --valscore)")
    ap.add_argument("--vs-worlds", help="world specs dir for the gold's worlds (default: toolchat/v8/worlds)")
    ap.add_argument("--vs-slices", help="val rows ({id, slice, ...}) that label each gold session's slice")
    ap.add_argument("--think", action="store_true",
                    help="traced checkpoints: pass --think to agent.py and valscore.py (default off)")
    ap.add_argument("--fast-kernels", action="store_true",
                    help="install flash-linear-attention + causal-conv1d on the kernel, kept only if a "
                         "GPU self-check matches the PyTorch reference (default off)")
    ap.add_argument("--no-snap", action="store_true"); ap.add_argument("--keep-ckpt", action="store_true")
    ap.add_argument("--machine", default="NvidiaTeslaT4")
    ap.add_argument("--dry", action="store_true", help="push: stage the dataset, upload nothing")
    ap.add_argument("--every", type=int, default=60)
    a = ap.parse_args()
    {"push": push, "status": status, "pull": pull, "wait": wait}[a.cmd](a)
