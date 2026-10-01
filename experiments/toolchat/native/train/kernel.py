"""Kaggle kernel: train, then score dev with the eval driver, in one run (SPEC §11.8, PLAN run 1).

Pushed by `kaggle.py push` with a dataset holding `bundle.tar.gz` (code, exported grammar,
nativetools binary + the loader and libs it was linked against, eval worlds and sets, data) and
`job.json`. Everything it writes lands in /kaggle/working:

    run.log                  this script's own log (every command, exit code, seconds)
    train.log                the trainer's log (mask assertion, loss, val, tok/s, TRUNCATED)
    ckpt/ckpt-025|050|100/   bf16 checkpoints (ckpt/FINAL names the last one); ckpt/train_meta.json
    eval/<arm>/...           the eval driver's outputs per decoding arm; eval/<arm>.log (batched: one
                             eval/<arm>-gpu<g>.log per GPU process, run-<g>.jsonl written as sessions finish)
    summary.json             job, timings, final checkpoint, arms run and their exit codes
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time

T0 = time.time()
W = os.environ.get("KERNEL_WORK", "/kaggle/working")  # overridable for a local rehearsal
D = os.path.dirname(glob.glob(os.environ.get("KERNEL_INPUT", "/kaggle/input") + "/**/job.json", recursive=True)[0])
JOB = json.load(open(os.path.join(D, "job.json")))
C = os.path.join(W, "code")
LOG = open(os.path.join(W, "run.log"), "a")
DEADLINE = T0 + JOB.get("kernel_hours", 11.5) * 3600  # Kaggle kills GPU sessions at 12 h
SUMMARY = {"job": JOB, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "stages": {}}


def say(*a):
    msg = " ".join(str(x) for x in a)
    print(msg, flush=True)
    LOG.write("%s %s\n" % (time.strftime("%H:%M:%S"), msg))
    LOG.flush()


def dump():
    SUMMARY["elapsed_s"] = round(time.time() - T0)
    json.dump(SUMMARY, open(os.path.join(W, "summary.json"), "w"), indent=1)


def sh(name, cmd, out=None, env=None, timeout=None, check=True):
    say("$", " ".join(cmd))
    t = time.time()
    fh = open(out, "w") if out else None
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE if fh else None, stderr=subprocess.STDOUT if fh else None,
                             text=True, env=env, cwd=C)
        if fh:
            for line in p.stdout:
                fh.write(line)
                fh.flush()
                print(line, end="", flush=True)
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        rc = -9
    SUMMARY["stages"][name] = {"exit": rc, "seconds": round(time.time() - t)}
    say("exit %d in %.0fs (%s)" % (rc, time.time() - t, name))
    dump()
    if check and rc:
        sys.exit(rc)
    return rc


def pip(*args, timeout=900):
    try:
        return subprocess.run([sys.executable, "-m", "pip", "install", "-q", *args], timeout=timeout).returncode == 0
    except subprocess.TimeoutExpired:
        return False


# ---- 1. code and environment
os.makedirs(C, exist_ok=True)
# Kaggle unpacks .tar.gz uploads server-side, so the builder ships `bundle.dat`; accept the
# archive under either name, or a tree Kaggle already unpacked (located by its binary).
_arch = [p for p in (os.path.join(D, n) for n in ("bundle.dat", "bundle.tar.gz")) if os.path.isfile(p)]
if _arch:
    with tarfile.open(_arch[0], "r:gz") as tf:
        tf.extractall(C)
else:
    _bin = glob.glob(os.path.dirname(D) + "/**/bin/nativetools.bin", recursive=True)
    if not _bin:
        raise SystemExit("bundle not found under %s: %s" % (D, sorted(os.listdir(D))))
    shutil.copytree(os.path.dirname(os.path.dirname(_bin[0])), C, dirs_exist_ok=True)
sh("pip", [sys.executable, "-m", "pip", "install", "-q", "transformers==%s" % JOB["transformers"],
           "llguidance==%s" % JOB["llguidance"]] + (["peft"] if "--lora" in JOB.get("train_args", []) else []))
# nativetools was linked against the builder's glibc; Kaggle's image is older, so run it
# through the loader and libs shipped next to it.
wrapper = os.path.join(C, "bin", "nativetools")
with open(wrapper, "w") as fh:
    fh.write('#!/bin/sh\nexec "%s/lib/ld-linux-x86-64.so.2" --library-path "%s/lib" "%s/bin/nativetools.bin" "$@"\n'
             % (C, C, C))
for f in glob.glob(os.path.join(C, "lib", "*")) + [wrapper, os.path.join(C, "bin", "nativetools.bin")]:
    os.chmod(f, 0o755)
ENV = dict(os.environ, NATIVETOOLS=wrapper, EVAL_VAULTS=os.path.join(W, "vaults"), PYTHONUNBUFFERED="1",
           TOKENIZERS_PARALLELISM="false")
sh("nativetools", [wrapper, "export", os.path.join(W, "export-check")], env=ENV)
NGPU = int(subprocess.run([sys.executable, "-c", "import torch; print(torch.cuda.device_count())"],
                          capture_output=True, text=True).stdout.strip() or 0)
say("GPUs", NGPU)
SUMMARY["gpus"] = NGPU

# ---- 2. optional fused kernels for Qwen3.5's linear-attention layers, kept only if the loss on
# a val example matches the PyTorch fallback's (they change speed, never the math)
PROBE = r"""
import json, sys, torch
sys.path.insert(0, "train")
import fmt, train
from transformers import AutoModelForCausalLM, AutoTokenizer
tok = AutoTokenizer.from_pretrained(sys.argv[1]); ex = next(fmt.read_examples(sys.argv[2]))
e = fmt.encode(tok, ex, json.load(open("export/tools-sig.json")))
m = AutoModelForCausalLM.from_pretrained(sys.argv[1], dtype=torch.float32).cuda()
with torch.no_grad():
    loss, n, _, _ = train.forward_loss(m, e["input_ids"], e["labels"], torch.device("cuda"))
print("PROBE", loss.item() / n)
"""


def probe():
    r = subprocess.run([sys.executable, "-c", PROBE, JOB["model"], os.path.join(C, JOB["val"] or JOB["train"])],
                       capture_output=True, text=True, cwd=C, env=ENV, timeout=900)
    for line in r.stdout.splitlines():
        if line.startswith("PROBE"):
            return float(line.split()[1])
    say("probe failed:", r.stderr[-800:])
    return None


if JOB.get("fast_kernels") and NGPU:
    ref = probe()
    for pkg, extra in (("flash-linear-attention", []), ("causal-conv1d", ["--no-build-isolation"])):
        t = time.time()
        ok = pip(*extra, pkg, timeout=1500)
        got = probe() if ok else None
        keep = ok and ref is not None and got is not None and abs(got - ref) <= 1e-3 * max(1.0, abs(ref))
        say("fast kernel %s: %s (loss %s vs %s) in %.0fs" % (pkg, "on" if keep else "off", got, ref, time.time() - t))
        SUMMARY.setdefault("fast_kernels", {})[pkg] = bool(keep)
        if ok and not keep:
            subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", pkg.replace("-", "_"), pkg])

# ---- 3. train (skipped for an eval-only job: `train` null, the arms drive JOB["model"] as is)
CK = os.path.join(W, "ckpt")
if not JOB.get("train"):
    final = JOB["model"]
    if JOB.get("ckpt_prefix"):  # a checkpoint staged in the (flat) dataset as ckpt.<name>: relink it as a folder
        final = os.path.join(W, "ckpt-in")
        os.makedirs(final, exist_ok=True)
        for f in JOB["ckpt_files"]:
            dst = os.path.join(final, f)
            if not os.path.lexists(dst):
                os.symlink(os.path.join(D, JOB["ckpt_prefix"] + f), dst)
    SUMMARY["final_ckpt"] = ("(dataset) " if JOB.get("ckpt_prefix") else "(base) ") + final
    say("no training: evaluating", final)
    dump()

t = ["--model", JOB["model"], "--train", JOB["train"], "--tools", "export/tools-sig.json", "--out", CK,
     "--hours", str(JOB["hours"])] + (["--val", JOB["val"]] if JOB.get("val") else []) \
    + (["--test", JOB["test"]] if JOB.get("test") else []) + JOB.get("train_args", [])
launch = [sys.executable, "-m", "torch.distributed.run", "--standalone", "--nproc_per_node", str(NGPU)] \
    if NGPU > 1 else [sys.executable]
if JOB.get("train"):
    sh("train", launch + ["train/train.py"] + t, out=os.path.join(W, "train.log"), env=ENV)
    if os.path.exists(os.path.join(CK, "PREEMPTED")):  # train.py --save-every/--resume caught a SIGTERM and stopped
        SUMMARY["preempted"] = open(os.path.join(CK, "PREEMPTED")).read()
        say("trainer preempted (resume checkpoint written): stopping before eval")
        dump()
        sys.exit(0)
    final = open(os.path.join(CK, "FINAL")).read().strip()
    SUMMARY["final_ckpt"] = final
    dump()

# ---- 3b. llama.cpp (phone setup, CPU): build the pinned llama.cpp with llguidance, convert the
# model to a BF16 GGUF, quantize one GGUF per arm (the arm name is the llama-quantize type)
LL = JOB.get("llama")
GGUF = {}
if LL:
    src = os.path.join(W, "llama.cpp")
    cargo = os.path.expanduser("~/.cargo/bin")
    if not shutil.which("cargo") and not os.path.exists(os.path.join(cargo, "cargo")):
        sh("rustup", ["bash", "-c", "curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"])
    LENV = dict(ENV, PATH=cargo + ":" + ENV["PATH"])
    sh("llama-clone", ["bash", "-c", "git init -q %s && cd %s && git remote add origin https://github.com/ggml-org/llama.cpp "
                       "&& git fetch -q --depth 1 origin %s && git checkout -q FETCH_HEAD" % (src, src, LL["commit"])])
    sh("llama-build", ["bash", "-c", "cd %s && cmake -B build -DCMAKE_BUILD_TYPE=Release -DLLAMA_LLGUIDANCE=ON -DLLAMA_CURL=OFF "
                       "-DLLAMA_BUILD_TESTS=OFF > cmake.log 2>&1 && cmake --build build -j%d --target llama-server llama-quantize "
                       "llama-bench" % (src, os.cpu_count() or 4)], env=LENV, out=os.path.join(W, "llama-build.log"))
    from huggingface_hub import snapshot_download
    hf = snapshot_download(JOB["model"])
    bf16 = os.path.join(W, "gguf-bf16.gguf")
    sh("gguf-convert", [sys.executable, os.path.join(src, "convert_hf_to_gguf.py"), hf, "--outtype", "bf16",
                        "--outfile", bf16], env=dict(ENV, PYTHONPATH=os.path.join(src, "gguf-py")),
       out=os.path.join(W, "gguf-convert.log"))
    for q in JOB["arms"]:
        GGUF[q] = os.path.join(W, "gguf-%s.gguf" % q)
        sh("quantize-" + q, [os.path.join(src, "build", "bin", "llama-quantize"), bf16, GGUF[q], q],
           out=os.path.join(W, "quantize-%s.log" % q))
        sh("bench-" + q, [os.path.join(src, "build", "bin", "llama-bench"), "-m", GGUF[q], "-t", str(LL["threads"]),
                          "-p", "512", "-n", "128"], out=os.path.join(W, "bench-%s.log" % q), check=False)
    say("cpu", os.cpu_count(), "threads", LL["threads"])

# ---- 4. score dev with the eval driver: one decoding arm per GPU, in parallel. Each arm drives
# the set in chunks (the driver writes its run file only at the end, so a chunk cut by the
# deadline loses only itself); the chunks are merged and scored here.
EVAL_SET = JOB.get("eval_set", "eval/sets/val.jsonl")


def fill(cmd, arm, **kw):
    B = JOB.get("eval_batched") or {}
    return [x.format(python=sys.executable, code=C, work=W, ckpt=os.path.join(CK, final) if JOB.get("train") else final, arm=arm,
                     out=os.path.join(W, "eval", arm), set=EVAL_SET, threads=B.get("threads", 32), wait=B.get("wait", 0.1),
                     **kw) for x in cmd]


def arm_script(arm, chunks):
    """The arm's chunks in order, in one process; a failed chunk does not stop the next. Without
    llama.cpp, `eval_procs` lanes run side by side on the arm's GPU (a 0.8B step is Python-bound, so
    the GPU is mostly idle in one process); chunk k goes to lane k % lanes."""
    import shlex
    cmds = [" ".join(shlex.quote(x) for x in fill(JOB["eval_drive"], arm, only=",".join(ids), part=k))
            for k, ids in enumerate(chunks)]
    lanes = 1 if LL else max(1, min(JOB.get("eval_procs", 1), len(cmds)))
    body = " ; ".join(cmds)
    if not LL:
        return " & ".join("( %s )" % " ; ".join(cmds[j::lanes]) for j in range(lanes)) + " ; wait"
    # the arm's own single-slot server (a phone serves one conversation), up for the arm's chunks only
    server = [os.path.join(W, "llama.cpp", "build", "bin", "llama-server"), "-m", GGUF[arm], "-t", str(LL["threads"]),
              "-np", "1", "-c", str(LL["ctx"]), "-cms", "64", "--port", "8089", "--no-webui"]
    return ("%s > %s 2>&1 & S=$! ; for i in $(seq 200); do curl -sf localhost:8089/health >/dev/null && break; kill -0 $S || exit 1; sleep 3; done ; %s ; kill $S"
            % (" ".join(shlex.quote(x) for x in server), shlex.quote(os.path.join(W, "eval", arm + "-server.log")), body))


def arm_env(arm, gpu=None):
    decoding, _, tools = arm.partition("@")  # "hard@engineered": decoding arm + prompt mode
    env = dict(ENV, **JOB.get("eval_env", {}), NATIVE_DECODING=decoding,
               NATIVE_LARK=os.path.join(C, "export", "call.lark"), EVAL_TMP=os.path.join(W, "tmp-" + arm))
    if gpu is not None:
        env["CUDA_VISIBLE_DEVICES"] = str(gpu)
    if tools:
        env["NATIVE_TOOLS"] = tools
    os.makedirs(env["EVAL_TMP"], exist_ok=True)
    return env


def merge_and_score(arm, returncode, ts):
    """Merge the arm's run-*.jsonl and score what was driven (a subset, or what a deadline cut off
    leaves), never sessions that are absent."""
    out = os.path.join(W, "eval", arm)
    parts = sorted(glob.glob(os.path.join(out, "run-*.jsonl")))
    with open(os.path.join(out, "run.jsonl"), "w") as fh:
        for f in parts:
            fh.write(open(f).read())
    driven = [json.loads(l)["id"] for l in open(os.path.join(out, "run.jsonl")) if l.strip()]
    done = len(driven)
    say("eval %s exit %s: %d of %d sessions driven" % (arm, returncode, done, len(ids)))
    only = ["--only", ",".join(driven)] if set(driven) != set(all_ids) else []
    rc = sh("score-" + arm, fill(JOB["eval_score"], arm) + only, env=ENV, out=os.path.join(out, "score.log"),
            check=False) if done else None
    SUMMARY["stages"]["eval-" + arm] = {"exit": returncode, "seconds": round(time.time() - ts),
                                        "sessions": done, "of": len(ids), "score_exit": rc}
    dump()


def wait_all(procs):
    for p in procs:
        try:
            p.wait(timeout=max(60, DEADLINE - time.time()))
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()


if JOB.get("eval_drive"):
    for c in JOB.get("eval_setup") or []:
        sh("eval-setup", fill(c, "-"), env=ENV, out=os.path.join(W, "eval-setup.log"), check=False)
    ids = all_ids = [json.loads(l)["id"] for l in open(os.path.join(C, EVAL_SET)) if l.strip()]
    if JOB.get("eval_only"):
        ids = [i for i in ids if i in set(JOB["eval_only"])]
    arms = JOB.get("arms", ["hard", "free"])
    if JOB.get("eval_batched") and not LL:
        # batched: one process per GPU per arm (CUDA_VISIBLE_DEVICES), each running `threads` sessions at
        # once against its own batched model; the processes take sessions from {out}/claims, so the GPUs
        # stay level. Arms run one after another, each over every GPU.
        for arm in arms:
            out = os.path.join(W, "eval", arm)
            shutil.rmtree(out, ignore_errors=True)
            os.makedirs(out)
            ts, procs = time.time(), []
            for g in range(max(NGPU, 1)):
                cmd = fill(JOB["eval_drive"], arm, only=",".join(ids), part=g)
                say("$ [gpu %d, %s] %d sessions, %s threads: %s" % (g, arm, len(ids), JOB["eval_batched"]["threads"],
                                                                   " ".join(cmd)[:300]))
                procs.append(subprocess.Popen(cmd, cwd=C, env=arm_env(arm, g if NGPU else None), stderr=subprocess.STDOUT,
                                              stdout=open(os.path.join(W, "eval", "%s-gpu%d.log" % (arm, g)), "w")))
            wait_all(procs)
            for g, p in enumerate(procs):
                stats = os.path.join(out, "run-%d.jsonl.stats.json" % g)
                if os.path.exists(stats):
                    say("gpu %d stats: %s" % (g, json.dumps(json.load(open(stats)))))
            merge_and_score(arm, [p.returncode for p in procs], ts)
            shutil.rmtree(os.path.join(W, "tmp-" + arm), ignore_errors=True)
            shutil.rmtree(os.path.join(out, "claims"), ignore_errors=True)
    else:
        n = max(1, min(JOB.get("eval_chunks", 6), len(ids)))
        chunks = [ids[k::n] for k in range(n)]
        procs = {}
        for i, arm in enumerate(arms):
            os.makedirs(os.path.join(W, "eval", arm), exist_ok=True)
            env = arm_env(arm, i % max(NGPU, 1))
            if LL:  # per-step latency and message log (NATIVE_STEP_LOG), one file per arm
                env.update(NATIVE_DECODING="hard", NATIVE_LLAMA_URL="http://127.0.0.1:8089", NATIVE_VERBOSE="1",
                           NATIVE_STEP_LOG=os.path.join(W, "eval", arm, "steps.jsonl"))
            script = arm_script(arm, chunks)
            say("$ [gpu %s, %s] %d sessions in %d chunks: %s" % (env["CUDA_VISIBLE_DEVICES"], arm, len(ids), n, script[:400]))
            p = subprocess.Popen(["bash", "-c", script], cwd=C, env=env, stderr=subprocess.STDOUT,
                                 stdout=open(os.path.join(W, "eval", arm + ".log"), "w"))
            procs[arm] = (p, time.time())
            if NGPU <= 1 or i % NGPU == NGPU - 1:  # every GPU busy: wait for this wave
                wait_all([q for q, _ in procs.values()])
        for arm, (p, ts) in procs.items():
            wait_all([p])
            merge_and_score(arm, p.returncode, ts)
        for arm in arms:
            shutil.rmtree(os.path.join(W, "tmp-" + arm), ignore_errors=True)

shutil.rmtree(C, ignore_errors=True)
shutil.rmtree(os.path.join(W, "vaults"), ignore_errors=True)
shutil.rmtree(os.path.join(W, "export-check"), ignore_errors=True)
SUMMARY["done"] = True
dump()
say("DONE in %.0fs" % (time.time() - T0))
