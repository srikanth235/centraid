"""Kaggle kernel: train one pilot and score it with the tool loop, on the GPU.

Pushed by kgl.py together with a dataset holding: tool-loop (the Rust scorer,
x86-64 linux, libc only), suite.json, agent.py, ft_chat.py, the data files and
job.json. Everything it writes lands in /kaggle/working, which kgl.py pulls.
"""
import glob, json, os, shutil, subprocess, sys, time

W = "/kaggle/working"
D = os.path.dirname(glob.glob("/kaggle/input/**/job.json", recursive=True)[0])
job = json.load(open(os.path.join(D, "job.json")))
log = open(os.path.join(W, "run.log"), "a")


def cleanup(ok=False):
    shutil.rmtree(os.path.join(W, "code"), ignore_errors=True)
    shutil.rmtree(os.path.join(W, "vs"), ignore_errors=True)
    # --keep-ckpt: the bf16 copy in ckpt_out is the job output; the fp32 ckpt the scorers read
    # goes only once everything ran and ckpt_out holds its weights (on any failure both stay)
    if not job.get("keep_ckpt") or (ok and os.path.exists(os.path.join(W, "ckpt_out", "model.safetensors"))):
        shutil.rmtree(os.path.join(W, "ckpt"), ignore_errors=True)


def sh(cmd, out=None, **kw):
    print("$", " ".join(cmd), flush=True)
    log.write("$ %s\n" % " ".join(cmd)); log.flush()
    t = time.time()
    if out:  # tee: the file for kgl.py pull, stdout for `kaggle kernels logs -f`
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, **kw)
        with open(out, "w") as fh:
            for line in p.stdout:
                fh.write(line); fh.flush()
                if not line.startswith("{"):
                    print(line, end="", flush=True)
        r = subprocess.CompletedProcess(cmd, p.wait())
    else:
        r = subprocess.run(cmd, **kw)
    log.write("exit %d in %.0fs\n" % (r.returncode, time.time() - t)); log.flush()
    if r.returncode:
        if out:
            print(open(out).read()[-3000:])
        cleanup()
        sys.exit(r.returncode)


sh([sys.executable, "-m", "pip", "install", "-q", "transformers==%s" % job.get("transformers", "5.17.0"), "peft"])


def fast_kernels():
    """Best effort: the fused kernels for Qwen3.5's gated-delta-net layers. transformers otherwise
    falls back to its PyTorch reference (correct, much slower). Each package is kept only if it
    installs within its time box and a tiny GPU forward matches the reference; any failure
    uninstalls it and the run goes on with the fallback, so this can cost time but never a run."""
    def pip(*args, timeout=900):
        try:
            return subprocess.run([sys.executable, "-m", "pip", *args], timeout=timeout).returncode == 0
        except subprocess.TimeoutExpired:
            return False
    # fp32 like the trainer and scorer; forward and backward against the unwrapped torch reference
    # (the transformers name dispatches to the package once installed, so the check unwraps it)
    check = r"""
import inspect, torch, torch.nn.functional as F
torch.manual_seed(0); dev = "cuda"
from transformers.models.qwen3_5 import modeling_qwen3_5 as m
from fla.ops.gated_delta_rule import chunk_gated_delta_rule
ref_fn = inspect.unwrap(m.torch_chunk_gated_delta_rule)
B, T, H, K = 1, 200, 2, 64
def inputs():
    torch.manual_seed(0)
    q, k = (F.normalize(torch.randn(B, T, H, K, device=dev), dim=-1) for _ in range(2))
    xs = [q, k, torch.randn(B, T, H, K, device=dev), -torch.rand(B, T, H, device=dev), torch.rand(B, T, H, device=dev)]
    return [x.requires_grad_() for x in xs]
res = []
for fn in (ref_fn, chunk_gated_delta_rule):
    xs = inputs(); o = fn(*xs, use_qk_l2norm_in_kernel=False)[0].float(); o.sum().backward()
    res.append([o.detach()] + [x.grad for x in xs])
err = max((a - b).abs().max().item() for a, b in zip(*res)); print("fla fwd+bwd max err", err); assert err < 1e-2, err
"""
    ccheck = r"""
import inspect, torch
from transformers.models.qwen3_5 import modeling_qwen3_5 as m
from causal_conv1d import causal_conv1d_fn
ref_fn = inspect.unwrap(m.causal_conv1d_fn)
torch.manual_seed(0)
x = torch.randn(2, 128, 64, device="cuda"); w = torch.randn(128, 4, device="cuda")
err = (causal_conv1d_fn(x, w, activation="silu") - ref_fn(x, w, activation="silu")).abs().max().item()
print("conv max err", err); assert err < 1e-3, err
"""
    for pkg, mod, chk, t in (("flash-linear-attention", "fla", check, 600),
                             ("causal-conv1d", "causal_conv1d", ccheck, 1500)):
        t0 = time.time()
        ok = pip("install", "-q", "--no-build-isolation", pkg, timeout=t) if mod == "causal_conv1d" \
            else pip("install", "-q", pkg, timeout=t)
        if ok:
            ok = subprocess.run([sys.executable, "-c", chk]).returncode == 0
        print("fast kernel %s: %s in %.0fs" % (pkg, "on" if ok else "off (fallback)", time.time() - t0), flush=True)
        log.write("fast kernel %s: %s\n" % (pkg, "on" if ok else "off")); log.flush()
        if not ok:
            pip("uninstall", "-y", "-q", pkg, timeout=120)


if job.get("fast_kernels"):
    fast_kernels()
code = os.path.join(W, "code")
shutil.copytree(D, code, dirs_exist_ok=True)
os.chmod(os.path.join(code, "tool-loop"), 0o755)
os.makedirs(os.path.join(code, "lib"), exist_ok=True)
for f in ("ld-linux-x86-64.so.2", "libc.so.6", "libm.so.6", "libgcc_s.so.1"):
    shutil.move(os.path.join(code, f), os.path.join(code, "lib", f))
    os.chmod(os.path.join(code, "lib", f), 0o755)
# the scorer finds its corpus next to where it was built
suite = "/home/user/centraid/crates/evalsuite"
os.makedirs(suite, exist_ok=True)
for c in ("suite.json", "holdout.json"):
    if os.path.exists(os.path.join(code, c)):
        shutil.copy(os.path.join(code, c), suite)
os.makedirs("/home/user/centraid/crates/candidates", exist_ok=True)

ck = os.path.join(W, "ckpt")
if job.get("train") and job.get("trainer"):
    t = ["--data", os.path.join(code, job["train"]), "--out", ck, "--bs", str(job.get("bs", 16)),
         "--lr", str(job.get("lr", 5e-5)), "--epochs", str(job.get("epochs", 2)),
         "--model", job.get("model", "ibm-granite/granite-4.0-350m")]
    if job.get("val"):
        t += ["--val", os.path.join(code, job["val"])]
    for k in ("max_steps", "n", "max_len"):
        if job.get(k):
            t += ["--" + k.replace("_", "-"), str(job[k])]
    t += job.get("trainer_args", [])
    sh([sys.executable, os.path.join(code, job["trainer"]), "train"] + t, out=os.path.join(W, "train.log"))
elif job.get("train"):
    t = ["--data", os.path.join(code, job["train"]), "--out", ck, "--bs", str(job.get("bs", 4)),
         "--lr", str(job.get("lr", 5e-5)), "--epochs", str(job.get("epochs", 3)), "--full",
         "--model", job.get("model", "ibm-granite/granite-4.0-350m")]
    if job.get("val"):
        t += ["--val", os.path.join(code, job["val"])]
    if job.get("lora"):
        t += ["--lora", str(job["lora"])]
    if job.get("max_steps"):
        t += ["--max-steps", str(job["max_steps"])]
    sh([sys.executable, os.path.join(code, "ft_chat.py"), "train"] + t, out=os.path.join(W, "train.log"))

if job.get("keep_ckpt"):  # the model is a job output: bf16 safetensors + tokenizer + config
    sh([sys.executable, "-c", "import sys, torch; from transformers import AutoModelForCausalLM, AutoTokenizer; "
        "m = AutoModelForCausalLM.from_pretrained(sys.argv[1], dtype=torch.bfloat16); "
        "m.save_pretrained(sys.argv[2], safe_serialization=True); "
        "AutoTokenizer.from_pretrained(sys.argv[1]).save_pretrained(sys.argv[2]); print('saved bf16', sys.argv[2])",
        ck, os.path.join(W, "ckpt_out")])

# job["think"] (kgl.py --think): a traced checkpoint generates reasoning before each call; every
# scorer runs the agent with --think. Absent: the flag is never passed (older bundles lack it).
think = ["--think"] if job.get("think") else []

for name, sc in job.get("score", {}).items():
    agent = [sys.executable, os.path.join(code, "agent.py"), "hf", "--ckpt", ck,
             "--log", os.path.join(W, name + ".steps.jsonl")] + (["--snap"] if sc.get("snap", True) else []) + think
    lib = os.path.join(code, "lib")
    sh([os.path.join(lib, "ld-linux-x86-64.so.2"), "--library-path", lib, os.path.join(code, "tool-loop"), "score", "--corpus", sc.get("corpus", "suite"),
        "--search", job.get("search", "plain")]
       + (["--sessions", os.path.join(code, sc["sessions"])] if sc.get("sessions") else [])
       + ["--turns", os.path.join(W, name + ".turns.jsonl"), "--agent"] + agent, out=os.path.join(W, name + ".score.log"))

vs = job.get("valscore")
if vs:  # in-distribution: the val sessions through `tool-loop serve`, judged as build3 judged them
    base = os.path.join(W, "vs")
    for d in ("final2", "rank", "worlds"):
        os.makedirs(os.path.join(base, d), exist_ok=True)
    shutil.copy(os.path.join(code, "core.py"), os.path.join(base, "final2"))
    for f in ("ranker.py", "onto.json"):
        shutil.copy(os.path.join(code, f), os.path.join(base, "rank"))
    for w in vs["worlds"]:
        shutil.copy(os.path.join(code, w + ".json"), os.path.join(base, "worlds"))
    os.makedirs("/home/user/centraid/crates/candidates/src", exist_ok=True)
    shutil.copy(os.path.join(code, "exec.rs"), "/home/user/centraid/crates/candidates/src/exec.rs")
    wrap = os.path.join(base, "tool-loop")
    lib = os.path.join(code, "lib")
    open(wrap, "w").write('#!/bin/sh\nexec %s --library-path %s %s "$@"\n' % (
        os.path.join(lib, "ld-linux-x86-64.so.2"), lib, os.path.join(code, "tool-loop")))
    os.chmod(wrap, 0o755)
    env = dict(os.environ, TOOL_LOOP=wrap, VS_CORE=os.path.join(base, "final2"), VS_TC=code,
               VS_WORLDS=os.path.join(base, "worlds"))
    sh([sys.executable, os.path.join(code, "valscore.py"), "score", "--gold", os.path.join(code, vs["gold"]),
        "--agent", "hf", "--ckpt", ck, "--out", os.path.join(W, "val.turns.jsonl"),
        "--log", os.path.join(W, "val.steps.jsonl"), "--n", str(vs.get("n", 0))] + think
       + (["--slices", os.path.join(code, vs["slices"])] if vs.get("slices") else []),
       out=os.path.join(W, "val.score.log"), env=env)
    sh([sys.executable, os.path.join(code, "valscore.py"), "report", "--turns", os.path.join(W, "val.turns.jsonl")],
       out=os.path.join(W, "val.report.log"), env=env)

cleanup(ok=True)
print("done", flush=True)
