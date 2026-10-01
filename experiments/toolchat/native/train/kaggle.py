"""Build (and optionally push) the Kaggle job: one dataset + one GPU kernel that trains and then
scores dev with the eval driver in a single run.

    python kaggle.py build <job> --train T.jsonl.gz --val V.jsonl.gz [--dry] [--hours 8] ...
    python kaggle.py build <job> --base --arms hard@engineered,hard@full [--eval-env '{...}']
                                      # eval only: no training, the arms drive `--model` as is
    python kaggle.py build <job> --ckpt-dir CKPT [--set eval/sets/val.jsonl] [--arms free] [--sample N]
                                      # fast eval of a local checkpoint: staged in the dataset, batched
                                      # (eval/run_batched.py, one process per GPU), free arm by default
    python kaggle.py push  <job>      # upload the staged dataset, wait until ready, push the kernel
    python kaggle.py status <job>
    python kaggle.py fetch <job> [--ckpt]   # logs + eval outputs; --ckpt also the final checkpoint

Staging: $KGL_STAGE (default <scratchpad>/kgl-native)/<job>/{data,kernel}. The dataset is flat:
`bundle.tar.gz` (train/, eval/, export/, bin/nativetools.bin, lib/ loader + libs, data/) and
`job.json`. `build --dry` stops after staging and prints the commands; nothing is uploaded.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
REPO = HERE.parents[3]
STAGE = Path(os.environ.get("KGL_STAGE", "/tmp/claude-0/-home-user-centraid/f31227f9-ca10-5f19-9c12-db2b239388c1/scratchpad/kgl-native"))
OUT = Path(os.environ.get("KGL_OUT", STAGE / "out"))
KAGGLE = os.environ.get("KAGGLE_BIN", "kaggle")
TRAIN_FILES = ["fmt.py", "train.py", "decode.py", "hf_backend.py", "llama_backend.py", "batching.py"]  # + ../render.py, the shared renderer
# Eval per arm (placeholders filled on the kernel; the arm's decoding reaches the driver as
# NATIVE_DECODING): the driver runs over the set in chunks ({only} = a chunk's session ids,
# {part} = its index), the kernel merges {out}/run-*.jsonl into {out}/run.jsonl and scores it.
EVAL_SET = "eval/sets/val.jsonl"
EVAL_DRIVE = ["{python}", "eval/run.py", "--set", "{set}", "--model", "hf", "--checkpoint", "{ckpt}",
              "--only", "{only}", "--out", "{out}/run-{part}.jsonl"]
# The batched driver (the default for the hf arms): `--threads` sessions at once against one batched
# model per GPU; the kernel starts one process per GPU (CUDA_VISIBLE_DEVICES, {part} = the GPU) that
# share the sessions through {out}/claims, and merges {out}/run-*.jsonl as above.
EVAL_DRIVE_BATCHED = ["{python}", "eval/run_batched.py", "--set", "{set}", "--checkpoint", "{ckpt}",
                      "--only", "{only}", "--out", "{out}/run-{part}.jsonl", "--claim", "{out}/claims",
                      "--threads", "{threads}", "--wait", "{wait}"]
EVAL_SCORE = ["{python}", "eval/score.py", "{out}/run.jsonl", "--gold", "{set}", "--out", "{out}/report.md",
              "--json", "{out}/report.json"]
EVAL_SETUP = [["{python}", "eval/seed_worlds.py"]]
# llama.cpp mode (`--llama Q4_K_M,Q8_0`): the phone setup on a CPU kernel. The kernel builds
# llama.cpp (pinned, with llguidance), converts the model to a BF16 GGUF, quantizes one GGUF per
# arm, and drives each arm through a single-slot llama-server (`--model llama`), one arm at a time.
LLAMA_COMMIT = "81ef10ea58fcc8a591cec50dc4b45e0bb00d9022"
LLAMA_DRIVE = ["{python}", "eval/run.py", "--set", "{set}", "--model", "llama", "--tools", "{tools}",
               "--only", "{only}", "--out", "{out}/run-{part}.jsonl"]


def sh(cmd, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    if check and r.returncode:
        sys.exit("%s\n%s" % (" ".join(cmd), out))
    return out


def user():
    for line in sh([KAGGLE, "config", "view"]).splitlines():
        if "username:" in line:
            return line.split(":", 1)[1].strip()
    sys.exit("kaggle CLI not authenticated (~/.kaggle/access_token)")


def slug(job):
    return "centraid-native-" + job.replace("_", "-").lower()


def binary(release: bool) -> Path:
    rel = REPO / "target" / "release" / "nativetools"
    if release:
        subprocess.run(["cargo", "build", "--release", "-p", "centraid-nativetools", "--bin", "nativetools"],
                       cwd=REPO, check=True)
    if rel.exists():
        return rel
    dbg = REPO / "target" / "debug" / "nativetools"
    if not dbg.exists():
        sys.exit("no nativetools binary: cargo build -p centraid-nativetools")
    print("note: shipping the DEBUG nativetools binary (pass --release to build the release one)")
    return dbg


def sig_tools(nt: Path, out: Path) -> None:
    """The tool list the runtime's prompt carries by default (`--tools sig`), for examples that
    name their tools only by `tools_hash` (the trainer asserts the hash)."""
    with tempfile.TemporaryDirectory() as d:
        v = Path(d) / "v.db"
        subprocess.run([str(nt), "seed", str(REPO / "crates/nativetools/tests/fixtures/world.json"), str(v)],
                       check=True, capture_output=True)
        r = subprocess.run([str(nt), "session", str(v), "--today", "2026-01-01", "--me", "x"],
                           input='{"op":"prompt"}\n', capture_output=True, text=True, check=True)
    out.write_text(json.dumps(json.loads(r.stdout)["tools"], ensure_ascii=False))


CKPT_KEEP = ("*.safetensors", "model.safetensors.index.json", "config.json", "generation_config.json",
             "tokenizer*", "vocab.json", "merges.txt", "chat_template*", "special_tokens_map.json",
             "added_tokens.json", "preprocessor_config.json")
CKPT_PREFIX = "ckpt."  # a Kaggle dataset is flat (no --dir-mode): the checkpoint's files sit at its top
                       # level as ckpt.<name>; the kernel links them into a folder under their own names


def stage_ckpt(src: Path, ds: Path) -> list[str]:
    """The weights + tokenizer files of a local checkpoint folder, hard-linked (else copied) into the
    flat dataset dir as ckpt.<name>. Optimizer states and the like are left out."""
    import fnmatch
    if not (src / "config.json").exists() or not list(src.glob("*.safetensors")):
        sys.exit("--ckpt-dir %s: needs config.json and *.safetensors (a save_pretrained folder)" % src)
    names = sorted(f.name for f in src.iterdir() if f.is_file() and any(fnmatch.fnmatch(f.name, g) for g in CKPT_KEEP))
    for n in names:
        dst = ds / (CKPT_PREFIX + n)
        try:
            os.link(src / n, dst)
        except OSError:
            shutil.copy(src / n, dst)
    return names


def set_sessions(a) -> list[dict]:
    """The sessions the eval will run: the set's, narrowed by --eval-only, then by --sample."""
    sys.path.insert(0, str(HERE))
    from batching import stratified_sample
    path = NATIVE / a.eval_set
    if not path.exists():
        return []
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    if a.eval_only:
        keep = set(a.eval_only.split(","))
        rows = [r for r in rows if r["id"] in keep]
    return stratified_sample(rows, a.sample)


def stage_eval(tree: Path, a, worlds: set[str]) -> None:
    """eval/ as it is on disk (no caches, no vaults) with only the chosen gold set (other sets, the
    test gold above all, stay home), plus the authored worlds the set needs: a val world lives in
    authored/worlds, and seed_worlds.py reads authored/split.py + split.json."""
    keep_set = (NATIVE / a.eval_set).resolve()
    junk = shutil.ignore_patterns("__pycache__", "*.pyc", "vaults", "*.db*", "out", "runs", "cache")

    def ignore(d, names):
        drop = set(junk(d, names))
        if Path(d).resolve() == keep_set.parent:
            drop |= {n for n in names if n.endswith(".jsonl") and (Path(d) / n).resolve() != keep_set}
        if "test" not in a.eval_set:
            drop |= {n for n in names if n.endswith("_test.py")}
        return drop

    shutil.copytree(NATIVE / "eval", tree / "eval", ignore=ignore)
    auth = NATIVE / "authored"
    if not auth.exists():
        return
    (tree / "authored" / "worlds").mkdir(parents=True)
    for f in ("split.py", "split.json"):
        if (auth / f).exists():
            shutil.copy(auth / f, tree / "authored" / f)
    for w in sorted(worlds):
        for suffix in (".json", ".keys.json"):
            f = auth / "worlds" / (w + suffix)
            if f.exists():
                shutil.copy(f, tree / "authored" / "worlds" / f.name)


def decision_args(a):
    """train.py's decision-token flags, passed through only when set (the defaults live in train.py)."""
    out = []
    for flag, val in (("--decision-weight", a.decision_weight), ("--decision-labels", a.decision_labels),
                      ("--decision-ref-labels", a.decision_ref_labels), ("--decision-params", a.decision_params),
                      ("--decision-skip-params", a.decision_skip_params), ("--hard-labels", a.hard_labels),
                      ("--hard-ref-labels", a.hard_ref_labels), ("--hard-params", a.hard_params),
                      ("--hard-ref-params", a.hard_ref_params), ("--hard-param-names", a.hard_param_names),
                      ("--hard-ref-sigil", a.hard_ref_sigil), ("--train-eval-n", a.train_eval_n)):
        if val is not None:
            out += [flag, str(val)]
    return out


def resume_args(a):
    """train.py's --save-every / --resume, passed through only when given (no flag: no resume checkpoints)."""
    return (["--save-every", str(a.save_every)] if a.save_every else []) + (["--resume"] if a.resume else [])


def build(a):
    job_dir = STAGE / a.job
    shutil.rmtree(job_dir, ignore_errors=True)
    ds, kd, tree = job_dir / "data", job_dir / "kernel", job_dir / "tree"
    for d in (ds, kd, tree / "train", tree / "bin", tree / "lib", tree / "data", tree / "export"):
        d.mkdir(parents=True)
    for f in TRAIN_FILES:
        shutil.copy(HERE / f, tree / "train" / f)
    shutil.copy(NATIVE / "render.py", tree / "render.py")  # fmt.py imports it from the parent dir
    sessions = set_sessions(a)
    worlds = {s["world"] for s in sessions}
    stage_eval(tree, a, worlds)
    nt = binary(a.release)
    shutil.copy(nt, tree / "bin" / "nativetools.bin")
    subprocess.run([str(nt), "export", str(tree / "export")], check=True, capture_output=True)
    sig_tools(nt, tree / "export" / "tools-sig.json")
    for f in ("/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/libc.so.6",
              "/lib/x86_64-linux-gnu/libm.so.6", "/lib/x86_64-linux-gnu/libgcc_s.so.1"):
        shutil.copy(os.path.realpath(f), tree / "lib" / os.path.basename(f))
    eval_only = a.base or a.ckpt_dir
    arms = (a.arms or ("free" if eval_only else "hard,free")).split(",")
    batched = not a.llama and not a.eval_drive and a.eval_threads > 0
    ids = [s["id"] for s in sessions]
    narrowed = bool(a.eval_only or a.sample) and bool(ids)
    setup = json.loads(a.eval_setup) if a.eval_setup else \
        [EVAL_SETUP[0] + sorted(worlds)] if worlds else EVAL_SETUP  # seed only the worlds the run touches
    job = {"model": a.model, "hours": a.hours, "kernel_hours": a.kernel_hours,
           "transformers": a.transformers, "llguidance": a.llguidance, "fast_kernels": a.fast_kernels,
           "train": "data/train" + "".join(Path(a.train).suffixes) if a.train else None, "val": None,
           "train_args": ["--bs", str(a.bs), "--lr", str(a.lr), "--max-len", str(a.max_len),
                          "--embed", a.embed, "--val-n", str(a.val_n)] + (["--lora", str(a.lora)] if a.lora else [])
                         + (["--max-steps", str(a.max_steps)] if a.max_steps else []) + decision_args(a)
                         + (["--no-grad-ckpt"] if a.no_grad_ckpt else []) + resume_args(a),
           "arms": arms, "eval_set": a.eval_set,
           "eval_drive": json.loads(a.eval_drive) if a.eval_drive else EVAL_DRIVE_BATCHED if batched else EVAL_DRIVE,
           "eval_score": json.loads(a.eval_score) if a.eval_score else EVAL_SCORE,
           "eval_setup": setup,
           "eval_env": dict({"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"} if batched else {},
                            **({"NATIVE_DTYPE": a.dtype} if a.dtype else {}),
                            **(json.loads(a.eval_env) if a.eval_env else {})),
           "eval_batched": {"threads": a.eval_threads, "wait": a.eval_wait} if batched else None,
           "eval_chunks": a.eval_chunks, "eval_procs": a.eval_procs, "eval_only": ids if narrowed else None}
    if a.ckpt_dir:
        names = stage_ckpt(Path(a.ckpt_dir).resolve(), ds)
        job["ckpt_prefix"], job["ckpt_files"] = CKPT_PREFIX, names
    if a.llama:
        job["llama"] = {"commit": LLAMA_COMMIT, "threads": a.llama_threads, "ctx": 32768}
        job["arms"] = a.llama.split(",")  # one arm per quantization
        job["eval_drive"] = [x.replace("{tools}", a.llama_tools) for x in LLAMA_DRIVE]
    if a.no_eval:
        job["eval_drive"] = None
    elif not (NATIVE / a.eval_set).exists():
        print("WARNING: %s does not exist yet: the kernel's eval stage would fail" % (NATIVE / a.eval_set))
    if a.train:
        shutil.copy(a.train, tree / job["train"])
    if a.val:
        job["val"] = "data/val" + "".join(Path(a.val).suffixes)
        shutil.copy(a.val, tree / job["val"])
    if a.test:  # the trainer opens it only for the last eval (kernel.py passes --test)
        job["test"] = "data/test" + "".join(Path(a.test).suffixes)
        shutil.copy(a.test, tree / job["test"])
    with tarfile.open(ds / "bundle.dat", "w:gz") as tf:
        for p in sorted(tree.iterdir()):
            tf.add(p, arcname=p.name)
    shutil.rmtree(tree)
    (ds / "job.json").write_text(json.dumps(job, indent=1))
    u = "USER" if a.dry else user()
    s = slug(a.job)
    (ds / "dataset-metadata.json").write_text(json.dumps({"title": s, "id": "%s/%s" % (u, s),
                                                          "licenses": [{"name": "other"}]}))
    shutil.copy(HERE / "kernel.py", kd / "kernel.py")
    (kd / "kernel-metadata.json").write_text(json.dumps({
        "id": "%s/%s-run" % (u, s), "title": s + "-run", "code_file": "kernel.py", "language": "python",
        "kernel_type": "script", "is_private": True, "enable_gpu": not a.llama, "enable_internet": True,
        **({} if a.llama else {"machine_shape": a.machine}), "dataset_sources": ["%s/%s" % (u, s)], "competition_sources": [],
        "kernel_sources": []}, indent=1))
    size = sum(f.stat().st_size for f in ds.rglob("*") if f.is_file())
    print("staged %s (%.1f MB): %s" % (ds, size / 1e6, ", ".join("%s %.1f MB" % (f.name, f.stat().st_size / 1e6)
                                                                  for f in sorted(ds.iterdir()))))
    if job.get("eval_drive"):
        print("eval: %d sessions%s, arms %s, %s" % (len(ids) or -1, " (sample %d)" % a.sample if a.sample else "", job["arms"],
              "batched: one process per GPU, %d threads each" % a.eval_threads if job["eval_batched"] else "chunked driver"))
        print("  per arm, per GPU g: " + " ".join(x.format(python="python", code="<code>", work="/kaggle/working",
              ckpt="<ckpt>", arm="<arm>", out="<out>", set=a.eval_set, only="<ids>", part="<g>", threads=a.eval_threads,
              wait=a.eval_wait) for x in job["eval_drive"]))
        print("  then: " + " ".join(x.format(python="python", out="<out>", set=a.eval_set) for x in job["eval_score"]))
    print("kernel %s" % kd)
    print(json.dumps(job, indent=1))
    commands(a.job, u)
    if a.dry:
        print("--dry: nothing uploaded")


def commands(job, u="<user>"):
    s, d = slug(job), STAGE / job
    print("""
push (first time creates, later versions):
  %(k)s datasets create -p %(d)s/data            # or: %(k)s datasets version -p %(d)s/data -m %(j)s
  %(k)s datasets status %(u)s/%(s)s               # repeat until "ready"
  %(k)s kernels push -p %(d)s/kernel
watch / fetch:
  %(k)s kernels status %(u)s/%(s)s-run
  %(k)s kernels output %(u)s/%(s)s-run -p %(o)s/%(j)s -o --file-pattern '^(?!ckpt/).*'
  # the final checkpoint too (~1.5 GB): --file-pattern '^ckpt/(FINAL|train_meta.json|ckpt-100/.*)$'
or simply: python %(me)s push %(j)s && python %(me)s fetch %(j)s""" % {
        "k": KAGGLE, "d": d, "j": job, "u": u, "s": s, "o": OUT, "me": Path(__file__).resolve()})


def push(a):
    u, s, d = user(), slug(a.job), STAGE / a.job
    meta = json.loads((d / "data" / "dataset-metadata.json").read_text())
    meta["id"] = "%s/%s" % (u, s)
    (d / "data" / "dataset-metadata.json").write_text(json.dumps(meta))
    km = json.loads((d / "kernel" / "kernel-metadata.json").read_text())
    km["id"], km["dataset_sources"] = "%s/%s-run" % (u, s), ["%s/%s" % (u, s)]
    (d / "kernel" / "kernel-metadata.json").write_text(json.dumps(km, indent=1))
    exists = subprocess.run([KAGGLE, "datasets", "status", "%s/%s" % (u, s)], capture_output=True).returncode == 0
    print(sh([KAGGLE, "datasets", "version", "-p", str(d / "data"), "-m", a.job] if exists
             else [KAGGLE, "datasets", "create", "-p", str(d / "data")]))
    for _ in range(90):
        if "ready" in sh([KAGGLE, "datasets", "status", "%s/%s" % (u, s)], check=False).lower():
            break
        time.sleep(10)
    print(sh([KAGGLE, "kernels", "push", "-p", str(d / "kernel")]))


def status(a):
    print(sh([KAGGLE, "kernels", "status", "%s/%s-run" % (user(), slug(a.job))], check=False))


def fetch(a):
    d = OUT / a.job
    d.mkdir(parents=True, exist_ok=True)
    pat = r"^(?!ckpt/).*" if not a.ckpt else r"^(?!ckpt/ckpt-0[25]).*"
    print(sh([KAGGLE, "kernels", "output", "%s/%s-run" % (user(), slug(a.job)), "-p", str(d), "-o",
              "--file-pattern", pat], check=False)[-2000:])
    print("fetched into", d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build", "push", "status", "fetch", "commands"])
    ap.add_argument("job")
    ap.add_argument("--train")
    ap.add_argument("--val")
    ap.add_argument("--test", help="test file staged for train.py --test (scored at the last eval only)")
    ap.add_argument("--decision-weight", type=float, help="train.py --decision-weight W (default 1.0: plain mean CE)")
    ap.add_argument("--decision-labels", help="train.py --decision-labels (think slot labels, comma list)")
    ap.add_argument("--decision-ref-labels", help="train.py --decision-ref-labels (default saw,last; '' = none)")
    ap.add_argument("--decision-params", help="train.py --decision-params (default: all call parameters)")
    ap.add_argument("--decision-skip-params", help="train.py --decision-skip-params (default question)")
    ap.add_argument("--hard-labels", help="train.py --hard-labels (hard-tier think slots, comma list; '' = none)")
    ap.add_argument("--hard-ref-labels", help="train.py --hard-ref-labels (default last; 'saw,last' adds the seen rows; '' = none)")
    ap.add_argument("--hard-params", help="train.py --hard-params (hard-tier call parameters; '' = none)")
    ap.add_argument("--hard-ref-params", help="train.py --hard-ref-params (default args; '' = none)")
    ap.add_argument("--hard-param-names", type=int, choices=(0, 1), help="train.py --hard-param-names (default 0)")
    ap.add_argument("--hard-ref-sigil", type=int, choices=(0, 1), help="train.py --hard-ref-sigil (default 0)")
    ap.add_argument("--train-eval-n", type=int, help="train.py --train-eval-n (default 300)")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="train.py --no-grad-ckpt (more memory, faster)")
    ap.add_argument("--save-every", type=int, default=0, help="train.py --save-every N (resume checkpoint every N steps; "
                    "default 0 = none)")
    ap.add_argument("--resume", action="store_true", help="train.py --resume (continue from the newest resume "
                    "checkpoint in the run's out folder, else start fresh)")
    ap.add_argument("--model", default="Qwen/Qwen3.5-0.8B")
    ap.add_argument("--hours", type=float, default=8.0, help="training wall-clock budget")
    ap.add_argument("--kernel-hours", type=float, default=11.5, help="whole-kernel deadline for eval")
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--max-len", type=int, default=8192)
    ap.add_argument("--embed", default="freeze", choices=["freeze", "train"])
    ap.add_argument("--val-n", type=int, default=400)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank (0 = full fine-tune)")
    ap.add_argument("--arms", help="decoding arms scored on the set (default: hard,free for a training job, free for an "
                    "eval-only one); `<decoding>@<tools>` also sets the prompt mode (e.g. hard@engineered). "
                    "Batched, the arms run one after another, each over all the GPUs")
    ap.add_argument("--ckpt-dir", help="eval only: a local checkpoint folder (save_pretrained), staged in the dataset; "
                                       "implies --base's no-training run, scored on --set")
    ap.add_argument("--sample", type=int, default=0, help="run a fixed stratified subset of N sessions (quick check)")
    ap.add_argument("--eval-threads", type=int, default=32, help="concurrent sessions per GPU process, batched together "
                    "(eval/run_batched.py); 0 = the old one-session-at-a-time chunked driver")
    ap.add_argument("--eval-wait", type=float, default=0.1, help="seconds a batch waits to fill")
    ap.add_argument("--dtype", help="NATIVE_DTYPE of the eval model (default float32; float16 is ~4x faster on a T4 "
                                    "but unchecked against float32 for this model)")
    ap.add_argument("--base", action="store_true", help="eval only: no training, the arms drive --model as is")
    ap.add_argument("--eval-env", help='JSON env for the eval arms, e.g. {"NATIVE_THINK_LIMIT": "512"}')
    ap.add_argument("--set", "--eval-set", dest="eval_set", default=EVAL_SET,
                    help="gold set, relative to experiments/toolchat/native (default eval/sets/val.jsonl)")
    ap.add_argument("--eval-drive", help="JSON command overriding the driver invocation (placeholders: "
                                         "{python} {code} {work} {ckpt} {arm} {out} {set} {only} {part})")
    ap.add_argument("--eval-score", help="JSON command overriding the scorer invocation")
    ap.add_argument("--eval-chunks", type=int, default=6, help="chunks per arm (a deadline cut loses one)")
    ap.add_argument("--eval-procs", type=int, default=2,
                    help="chunk processes per arm run side by side on its GPU (Kaggle has 4 vCPUs: 2 arms x 2)")
    ap.add_argument("--eval-only", help="comma list of session ids to score (default: the whole set)")
    ap.add_argument("--eval-setup", help="JSON list of commands run once before the eval arms")
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--llama", help="phone setup: CPU kernel, llama.cpp, one arm per GGUF quantization "
                                    "(e.g. Q4_K_M,Q8_0); needs --base")
    ap.add_argument("--llama-threads", type=int, default=4)
    ap.add_argument("--llama-tools", default="engineered", help="prompt mode of the llama arms")
    ap.add_argument("--fast-kernels", action="store_true", help="try fla + causal-conv1d (kept only if exact)")
    ap.add_argument("--transformers", default="5.17.0")
    ap.add_argument("--llguidance", default="1.8.0")
    ap.add_argument("--machine", default="NvidiaTeslaT4")
    ap.add_argument("--release", action="store_true", help="cargo build --release nativetools first")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--ckpt", action="store_true", help="fetch: also the final checkpoint")
    a = ap.parse_args()
    if a.cmd == "build":
        if a.train and a.ckpt_dir:
            sys.exit("--ckpt-dir is an eval-only job: drop --train")
        if not a.train and not a.base and not a.ckpt_dir:
            sys.exit("build needs --train (or --base / --ckpt-dir for an eval-only run)")
        if a.base and a.no_eval:
            sys.exit("--base with --no-eval would do nothing")
        build(a)
    elif a.cmd == "commands":
        commands(a.job)
    else:
        {"push": push, "status": status, "fetch": fetch}[a.cmd](a)


if __name__ == "__main__":
    main()
