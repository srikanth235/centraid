"""Stage a job bundle: the code, runtime and data one GCP Spot VM needs to train and/or score a checkpoint.

    python bundle.py build <job> --train T.jsonl.gz --val V.jsonl.gz [--test X.jsonl.gz] [--set eval/sets/val.jsonl] ...
                                      # a training job: train/vm/run_job.sh trains it, then scores the final checkpoint on --set
    python bundle.py build <job> --base --set eval/sets/val.jsonl
                                      # eval only: no training, the arm drives `--model` as is (a scoring bundle)
    python bundle.py build <job> --ckpt-dir CKPT --set eval/sets/val.jsonl [--sample N]
                                      # eval only on a local checkpoint, shipped inside the job's data dir

`train/vm/bundles.sh` builds the three scoring bundles (trainfit, val, test) that `train/vm/score_ckpt.sh` runs.

Staging: $BUNDLE_STAGE (default ${TMPDIR:-/tmp}/centraid-bundles)/<job>/{data,kernel}. data/ is flat: `bundle.dat` (a gzip
tar of train/, eval/, authored/, export/, bin/nativetools.bin, lib/ loader + libs, data/ and render.py) and `job.json`, plus
ckpt.<name> files for --ckpt-dir. kernel/ holds kernel.py. A build only stages: launch.sh and score_ckpt.sh upload.
$BUNDLE_NATIVETOOLS names the exact runtime build to ship (default: the repo's target/release or target/debug build).

Trainer flags: job.json `train_args` carries --bs, --lr, --max-len, --embed, --val-n and, only when given, the loss, order and mark
flags (`train_args`): --decision-weight, --decision-*/--hard-* (the decision and hard tiers), --copy-weight and --copy-labels (the
copy tier), --pair-batches / --no-pair-batches (minimal pairs in one step), --checkpoints, --train-eval-n, --save-every, --resume.
Their defaults live in train.py (decision weight 2, copy weight 0, pair batching on, marks at 25 / 50 / 75 / 100 %); a flag
given here pins that choice in the job, e.g. `--decision-weight 1 --copy-weight 1 --no-pair-batches` is the legacy loss and order.

Continuation (`--continue-from gs://.../ckpt`, e.g. an RFT or DPO step on the soup): one flag for the continuation defaults, init from that
checkpoint (job.json `init`, as --init-ckpt), 1 epoch (`--epochs 1` in `train_args`, else run_job.sh's per-launch default applies), lr 4e-6
decaying to --min-lr 0.05, --warmup 0.02, --ema 0.999. A flag given explicitly wins over the preset's value; --init-ckpt stays as it
was (give --continue-from or --init-ckpt, not both). DPO (`--dpo PAIRS.jsonl[.gz] --dpo-beta B --dpo-sft S`): the pair file is staged as
data/dpo.jsonl[.gz] and train.py runs the DPO loss (see its docstring); --train is still required (run_job.sh passes job.json `train`
to the trainer unconditionally), and train.py only scores it (the original-data drift sample), never trains on it.

Scoring defaults, the same for every bundle: arm `free`, eval/run_batched.py with 16 sessions per process and a 0.05 s batch
wait, 4 processes sharing one GPU and one claims directory (--eval-procs, --eval-chunks), OMP_NUM_THREADS=4 and expandable
CUDA segments. --eval-drive, --eval-env, --eval-chunks and --eval-procs override them. Decoding is always free (greedy, nothing
masked, the runtime parses the model's text), so `free` is the only arm: it names the output folder eval/free/, and `--arms
free@sig|compact|full` adds the tools-block spelling (NATIVE_TOOLS); any other arm is refused.
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
from pathlib import Path

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
REPO = HERE.parents[3]
sys.path.insert(0, str(NATIVE))
import render  # noqa: E402  (the shared renderer: the model's tokenizer id is its identity.json)
STAGE = Path(os.environ.get("BUNDLE_STAGE") or Path(os.environ.get("TMPDIR") or "/tmp") / "centraid-bundles")
TRAIN_FILES = ["fmt.py", "train.py", "decode.py", "hf_backend.py", "batching.py"]
# + ../render.py, the shared renderer, and ../authored/trace.py (fmt.py compiles the slot trace with it; stage_eval copies it)
# Scoring. Placeholders are filled by kernel.py. The driver runs `--threads` sessions at once against one batched model. `eval_procs` driver processes share the GPU (a 0.8B step is Python
# bound, so one process leaves it mostly idle) and one claims directory, so every session runs once; `eval_chunks` launches
# in all ({part} = a launch's index, {only} = its session ids when the run is narrowed). The kernel merges {out}/run-*.jsonl
# into {out}/run.jsonl and scores it.
EVAL_SET = "eval/sets/val.jsonl"
EVAL_DRIVE = ["{python}", "eval/run_batched.py", "--set", "{set}", "--checkpoint", "{ckpt}", "--out", "{out}/run-{part}.jsonl",
              "--claim", "{out}/claims", "--threads", "16", "--wait", "0.05"]
EVAL_ENV = {"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "OMP_NUM_THREADS": "4"}
EVAL_CHUNKS, EVAL_PROCS = 4, 4
EVAL_SCORE = ["{python}", "eval/score.py", "{out}/run.jsonl", "--gold", "{set}", "--out", "{out}/report.md",
              "--json", "{out}/report.json"]
EVAL_SETUP = [["{python}", "eval/seed_worlds.py"]]
# Multi-GPU hosts (`--eval-threads N`): the kernel starts one driver process per GPU (CUDA_VISIBLE_DEVICES, {part} = the
# GPU); the processes share the sessions through {out}/claims. run_job.sh's combined scoring needs the default drive instead.
EVAL_DRIVE_BATCHED = ["{python}", "eval/run_batched.py", "--set", "{set}", "--checkpoint", "{ckpt}",
                      "--only", "{only}", "--out", "{out}/run-{part}.jsonl", "--claim", "{out}/claims",
                      "--threads", "{threads}", "--wait", "{wait}"]


def binary(release: bool) -> Path:
    if os.environ.get("BUNDLE_NATIVETOOLS"):  # an exact runtime build to ship (e.g. the one the gold was verified with)
        nt = Path(os.environ["BUNDLE_NATIVETOOLS"])
        if not nt.is_file():
            sys.exit("BUNDLE_NATIVETOOLS=%s is not a file" % nt)
        return nt
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
CKPT_PREFIX = "ckpt."  # data/ is uploaded flat: the checkpoint's files sit at its top level as ckpt.<name>;
                       # kernel.py links them into a folder under their own names


def stage_ckpt(src: Path, ds: Path) -> list[str]:
    """The weights + tokenizer files of a local checkpoint folder, hard-linked (else copied) into the
    flat data dir as ckpt.<name>. Optimizer states and the like are left out."""
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


def check_arms(arms: str | None) -> list[str]:
    """`--arms`: `free`, the only arm (decoding is always free), optionally `free@sig|compact|full` for the tools-block spelling.
    Anything else is refused, here and again by kernel.py."""
    out = (arms or "free").split(",")
    for arm in out:
        name, _, tools = arm.partition("@")
        if name != "free" or (tools and tools not in ("sig", "compact", "full")):
            sys.exit("--arms %s: the only arm is `free` (decoding is unconstrained); `free@sig|compact|full` sets the tools-block "
                     "spelling" % arm)
    return out


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
    for f in ("split.py", "split.json", "trace.py"):
        if (auth / f).exists():
            shutil.copy(auth / f, tree / "authored" / f)
    # BUNDLE_WORLDS: a directory of <W>.json / <W>.keys.json that win over authored/worlds (the worlds a rollout set's gold was built
    # on: the collision worlds, `authored/build.py --worlds-dir`); the bundle then seeds those, so the gold's keys exist in the vault
    over = Path(os.environ["BUNDLE_WORLDS"]) if os.environ.get("BUNDLE_WORLDS") else None
    for w in sorted(worlds):
        for suffix in (".json", ".keys.json"):
            f = over / (w + suffix) if over is not None and (over / (w + suffix)).exists() else auth / "worlds" / (w + suffix)
            if f.exists():
                shutil.copy(f, tree / "authored" / "worlds" / f.name)


def decision_args(a):
    """train.py's loss, order and checkpoint flags (decision and hard tokens, copy tokens, minimal pairs, the marks), passed
    through only when set: the defaults live in train.py (`--decision-weight` 2, `--copy-weight` 0, pair batching on, marks at
    25 / 50 / 75 / 100 %), and a flag given here is pinned in the staged job.json."""
    out = []
    for flag, val in (("--decision-weight", a.decision_weight), ("--decision-labels", a.decision_labels),
                      ("--decision-ref-labels", a.decision_ref_labels), ("--decision-params", a.decision_params),
                      ("--decision-skip-params", a.decision_skip_params), ("--hard-labels", a.hard_labels),
                      ("--hard-ref-labels", a.hard_ref_labels), ("--hard-params", a.hard_params),
                      ("--hard-ref-params", a.hard_ref_params), ("--hard-param-names", a.hard_param_names),
                      ("--hard-ref-sigil", a.hard_ref_sigil), ("--copy-weight", a.copy_weight),
                      ("--copy-labels", a.copy_labels), ("--checkpoints", a.checkpoints),
                      ("--train-eval-n", a.train_eval_n)):
        if val is not None:
            out += [flag, str(val)]
    if a.pair_batches is not None:  # a tri-state: not given = train.py's default (on)
        out.append("--pair-batches" if a.pair_batches else "--no-pair-batches")
    return out


CONTINUE = {"lr": 4e-6, "min_lr": 0.05, "warmup": 0.02, "ema": 0.999, "epochs": 1}  # --continue-from's defaults
LR = 2e-5                                                                           # --lr without --continue-from


def resolve(a) -> None:
    """Fill the flags the user left out (they parse as None): --continue-from sets init, 1 epoch, lr 4e-6, min-lr 0.05, warmup 0.02 and ema
    0.999; without it only --lr has a value of its own (2e-5; the others stay unset and train.py's defaults apply). An explicit flag wins.
    Idempotent."""
    if a.continue_from:
        if a.init_ckpt and a.init_ckpt != a.continue_from:
            sys.exit("--continue-from %s and --init-ckpt %s name two starting points: give one" % (a.continue_from, a.init_ckpt))
        a.init_ckpt = a.continue_from
        for k, v in CONTINUE.items():
            if getattr(a, k) is None:
                setattr(a, k, v)
    if a.lr is None:
        a.lr = LR


def dpo_args(a):
    """train.py's --dpo (the file as staged inside the bundle), --dpo-beta and --dpo-sft, passed through only when given."""
    if not a.dpo:
        return []
    return ["--dpo", "data/dpo" + "".join(Path(a.dpo).suffixes)] + sum(
        ([flag, str(v)] for flag, v in (("--dpo-beta", a.dpo_beta), ("--dpo-sft", a.dpo_sft)) if v is not None), [])


def resume_args(a):
    """train.py's --save-every / --resume, passed through only when given (no flag: no resume checkpoints)."""
    return (["--save-every", str(a.save_every)] if a.save_every else []) + (["--resume"] if a.resume else [])


def train_args(a):
    """The trainer flags the staged job carries (job.json `train_args`; run_job.sh adds --model/--train/--out/--hours, --epochs and
    --save-every). Optional flags are there only when given."""
    resolve(a)
    return (["--bs", str(a.bs), "--lr", str(a.lr), "--max-len", str(a.max_len), "--embed", a.embed, "--val-n", str(a.val_n)]
            + (["--lora", str(a.lora)] if a.lora else []) + (["--max-steps", str(a.max_steps)] if a.max_steps else [])
            + (["--warmup", str(a.warmup)] if a.warmup is not None else []) + (["--min-lr", str(a.min_lr)] if a.min_lr is not None else [])
            + decision_args(a) + (["--ema", str(a.ema)] if a.ema else []) + (["--no-grad-ckpt"] if a.no_grad_ckpt else [])
            + (["--epochs", str(a.epochs)] if a.epochs is not None else []) + dpo_args(a) + resume_args(a))


def check_set(a) -> None:
    """--set is a file under eval/ (the bundle ships eval/): normalised to a path relative to native/."""
    path = Path(os.path.abspath(NATIVE / a.eval_set))
    try:
        rel = path.relative_to(NATIVE / "eval")
    except ValueError:
        sys.exit("--set %s: the set must be a file under %s (the bundle ships eval/)" % (a.eval_set, NATIVE / "eval"))
    a.eval_set = (Path("eval") / rel).as_posix()
    if not a.no_eval and not path.is_file():
        sys.exit("--set %s does not exist: the kernel's eval stage would fail (--no-eval skips it)" % path)


def build(a):
    resolve(a)
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
    # nativetools is linked against the builder's glibc, which can be newer than the VM image's: ship the loader and libs
    for f in ("/lib64/ld-linux-x86-64.so.2", "/lib/x86_64-linux-gnu/libc.so.6",
              "/lib/x86_64-linux-gnu/libm.so.6", "/lib/x86_64-linux-gnu/libgcc_s.so.1"):
        shutil.copy(os.path.realpath(f), tree / "lib" / os.path.basename(f))
    arms = check_arms(a.arms)
    batched = a.eval_threads > 0 and not a.eval_drive
    ids = [s["id"] for s in sessions]
    narrowed = bool(a.eval_only or a.sample) and bool(ids)
    setup = json.loads(a.eval_setup) if a.eval_setup else \
        [EVAL_SETUP[0] + sorted(worlds)] if worlds else EVAL_SETUP  # seed only the worlds the run touches
    drive = json.loads(a.eval_drive) if a.eval_drive else EVAL_DRIVE_BATCHED if batched else \
        EVAL_DRIVE + (["--only", "{only}"] if narrowed else [])
    job = {"model": a.model, "init": a.init_ckpt, "hours": a.hours, "kernel_hours": a.kernel_hours,
           "transformers": a.transformers, "fast_kernels": a.fast_kernels,
           "train": "data/train" + "".join(Path(a.train).suffixes) if a.train else None, "val": None,
           "train_args": train_args(a),
           "arms": arms, "eval_set": a.eval_set, "eval_drive": drive,
           "eval_score": json.loads(a.eval_score) if a.eval_score else EVAL_SCORE,
           "eval_setup": setup,
           "eval_env": dict(EVAL_ENV, **({"NATIVE_DTYPE": a.dtype} if a.dtype else {}),
                            **(json.loads(a.eval_env) if a.eval_env else {})),
           "eval_batched": {"threads": a.eval_threads, "wait": a.eval_wait} if batched else None,
           "eval_chunks": a.eval_chunks, "eval_procs": a.eval_procs, "eval_only": ids if narrowed else None}
    if a.ckpt_dir:
        names = stage_ckpt(Path(a.ckpt_dir).resolve(), ds)
        job["ckpt_prefix"], job["ckpt_files"] = CKPT_PREFIX, names
    if a.no_eval:
        job["eval_drive"] = None
    if a.train:
        shutil.copy(a.train, tree / job["train"])
    if a.val:
        job["val"] = "data/val" + "".join(Path(a.val).suffixes)
        shutil.copy(a.val, tree / job["val"])
    if a.dpo:  # the pair file, beside train; train_args names it (`--dpo data/dpo.jsonl[.gz]`)
        shutil.copy(a.dpo, tree / "data" / ("dpo" + "".join(Path(a.dpo).suffixes)))
    if a.test:  # the trainer opens it only for the last eval (kernel.py passes --test)
        job["test"] = "data/test" + "".join(Path(a.test).suffixes)
        shutil.copy(a.test, tree / job["test"])
    with tarfile.open(ds / "bundle.dat", "w:gz") as tf:
        for p in sorted(tree.iterdir()):
            tf.add(p, arcname=p.name)
    shutil.rmtree(tree)
    (ds / "job.json").write_text(json.dumps(job, indent=1))
    shutil.copy(HERE / "kernel.py", kd / "kernel.py")
    size = sum(f.stat().st_size for f in ds.rglob("*") if f.is_file())
    print("staged %s (%.1f MB): %s" % (ds, size / 1e6, ", ".join("%s %.1f MB" % (f.name, f.stat().st_size / 1e6)
                                                                  for f in sorted(ds.iterdir()))))
    if job.get("eval_drive"):
        how = ("batched: one process per GPU, %d threads each" % a.eval_threads if job["eval_batched"]
               else "%d launches, %d side by side on the GPU" % (a.eval_chunks, a.eval_procs))
        print("eval: %d sessions%s, arms %s, %s" % (len(ids), " (sample %d)" % a.sample if a.sample else "", job["arms"], how))
        fill = dict(python="python", code="<code>", work="<work>", ckpt="<ckpt>", arm="<arm>", out="<out>", set=a.eval_set,
                    only="<ids>", part="<part>", threads=a.eval_threads, wait=a.eval_wait)
        print("  per arm: " + " ".join(x.format(**fill) for x in job["eval_drive"]))
        print("  then: " + " ".join(x.format(**fill) for x in job["eval_score"]))
    print("kernel %s" % kd)
    print(json.dumps(job, indent=1))
    if a.base or a.ckpt_dir:
        print("\nan eval-only job is a scoring bundle: train/vm/bundles.sh stages trainfit, val and test; "
              "train/vm/score_ckpt.sh runs them")
    else:
        print("\nnext: JOB=%s BUCKET=<bucket> STAGE_DIR=%s train/vm/probe.sh (measure first), then train/vm/launch.sh"
              % (a.job, job_dir))


def parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["build"])
    ap.add_argument("job")
    ap.add_argument("--train")
    ap.add_argument("--val")
    ap.add_argument("--test", help="test file staged for train.py --test (scored at the last eval only)")
    ap.add_argument("--decision-weight", type=float, help="train.py --decision-weight W (default 2.0; 1.0 = plain mean CE)")
    ap.add_argument("--copy-weight", type=float, help="train.py --copy-weight C (default 0.0: no loss on the think values that are "
                    "verbatim copies of the user's message; 1.0 = as any other token)")
    ap.add_argument("--copy-labels", help="train.py --copy-labels (think slots whose value may be such a copy, comma list; "
                    "default intent,set,text,question; '' = none)")
    ap.add_argument("--pair-batches", action=argparse.BooleanOptionalAction, default=None,
                    help="train.py --pair-batches / --no-pair-batches (minimal pairs share an optimizer step; default on)")
    ap.add_argument("--checkpoints", help="train.py --checkpoints (fractions of the steps at which a mark is evaluated and saved; "
                    "default 0.25,0.5,0.75,1.0)")
    ap.add_argument("--decision-labels", help="train.py --decision-labels (think slot labels, comma list)")
    ap.add_argument("--decision-ref-labels", help="train.py --decision-ref-labels (default none)")
    ap.add_argument("--decision-params", help="train.py --decision-params (default: all call parameters)")
    ap.add_argument("--decision-skip-params", help="train.py --decision-skip-params (default question)")
    ap.add_argument("--hard-labels", help="train.py --hard-labels (hard-tier think slots, comma list; '' = none)")
    ap.add_argument("--hard-ref-labels", help="train.py --hard-ref-labels (default refer; '' = none)")
    ap.add_argument("--hard-params", help="train.py --hard-params (hard-tier call parameters; '' = none)")
    ap.add_argument("--hard-ref-params", help="train.py --hard-ref-params (default args; '' = none)")
    ap.add_argument("--hard-param-names", type=int, choices=(0, 1), help="train.py --hard-param-names (default 0)")
    ap.add_argument("--hard-ref-sigil", type=int, choices=(0, 1), help="train.py --hard-ref-sigil (default 0)")
    ap.add_argument("--train-eval-n", type=int, help="train.py --train-eval-n (default 300)")
    ap.add_argument("--ema", type=float, metavar="D", help="train.py --ema D (weight EMA saved beside every mark as "
                    "ckpt-NNN-ema; e.g. 0.999; passed only when given; 0 = none)")
    ap.add_argument("--epochs", type=int, help="train.py --epochs N (passed only when given, else run_job.sh's per-launch epochs "
                    "apply; --continue-from sets 1)")
    ap.add_argument("--continue-from", metavar="GS_CKPT", help="a continuation in one flag: --init-ckpt GS_CKPT, --epochs 1, --lr 4e-6 "
                    "decaying to --min-lr 0.05, --warmup 0.02, --ema 0.999; each explicit flag wins over the preset")
    ap.add_argument("--dpo", metavar="PAIRS", help="train.py --dpo: DPO on a (gzipped) JSONL of {id, chosen, rejected} records, "
                    "staged into the bundle; needs --train too (scored for drift, never trained on)")
    ap.add_argument("--dpo-beta", type=float, help="train.py --dpo-beta (default 0.1; passed only when given)")
    ap.add_argument("--dpo-sft", type=float, help="train.py --dpo-sft (weight of the SFT term on the chosen record, default 0.2; "
                    "passed only when given)")
    ap.add_argument("--no-grad-ckpt", action="store_true", help="train.py --no-grad-ckpt (more memory, faster)")
    ap.add_argument("--save-every", type=int, default=0, help="train.py --save-every N (resume checkpoint every N steps; "
                    "default 0 = none)")
    ap.add_argument("--resume", action="store_true", help="train.py --resume (continue from the newest resume "
                    "checkpoint in the run's out folder, else start fresh)")
    ap.add_argument("--model", default=render.TOKENIZER)
    ap.add_argument("--init-ckpt", help="gs:// checkpoint directory the training starts from instead of --model (job.json `init`; "
                    "run_job.sh pulls it): a continuation run")
    ap.add_argument("--hours", type=float, default=8.0, help="training wall-clock budget")
    ap.add_argument("--kernel-hours", type=float, default=11.5, help="whole-kernel deadline for eval (hours): kernel.py "
                    "kills the eval processes still running then and scores what they finished")
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, help="learning rate (default 2e-5; 4e-6 with --continue-from)")
    ap.add_argument("--warmup", type=float, help="train.py --warmup (fraction of steps; passed only when given)")
    ap.add_argument("--min-lr", type=float, help="train.py --min-lr (final lr as a fraction of --lr; passed only when given)")
    ap.add_argument("--max-len", type=int, default=8192)
    ap.add_argument("--embed", default="freeze", choices=["freeze", "train"])
    ap.add_argument("--val-n", type=int, default=400)
    ap.add_argument("--max-steps", type=int, default=0)
    ap.add_argument("--lora", type=int, default=0, help="LoRA rank (0 = full fine-tune)")
    ap.add_argument("--arms", help="arms scored on the set, comma list (default free, the only arm: greedy unconstrained "
                    "decoding, outputs in eval/free/); `free@<tools>` also sets the tools-block spelling (sig, compact or full)")
    ap.add_argument("--ckpt-dir", help="eval only: a local checkpoint folder (save_pretrained), shipped in the job's "
                                       "data dir; implies --base's no-training run, scored on --set")
    ap.add_argument("--sample", type=int, default=0, help="run a fixed stratified subset of N sessions (quick check)")
    ap.add_argument("--eval-threads", type=int, default=0, help="multi-GPU hosts: one batched driver process per GPU with "
                    "N concurrent sessions each (job.json eval_batched); 0 = the default drive, which run_job.sh's "
                    "combined scoring needs")
    ap.add_argument("--eval-wait", type=float, default=0.1, help="seconds a batch waits to fill (with --eval-threads)")
    ap.add_argument("--dtype", help="NATIVE_DTYPE of the eval model (default float32; float16 is faster but unchecked "
                                    "against float32 for this model)")
    ap.add_argument("--base", action="store_true", help="eval only: no training, the arms drive --model as is")
    ap.add_argument("--eval-env", help='JSON env for the eval arms, merged over the defaults (PYTORCH_CUDA_ALLOC_CONF, '
                                       'OMP_NUM_THREADS), e.g. {"OMP_NUM_THREADS": "8"}')
    ap.add_argument("--set", "--eval-set", dest="eval_set", default=EVAL_SET,
                    help="gold set, a file under eval/, relative to experiments/toolchat/native (default eval/sets/val.jsonl)")
    ap.add_argument("--eval-drive", help="JSON command overriding the driver invocation (placeholders: "
                                         "{python} {code} {work} {ckpt} {arm} {out} {set} {only} {part})")
    ap.add_argument("--eval-score", help="JSON command overriding the scorer invocation")
    ap.add_argument("--eval-chunks", type=int, default=EVAL_CHUNKS, help="driver launches per arm; --eval-procs of them "
                    "run side by side (a narrowed run splits its session ids across them)")
    ap.add_argument("--eval-procs", type=int, default=EVAL_PROCS,
                    help="driver processes run side by side on an arm's GPU (one claims directory shares the sessions)")
    ap.add_argument("--eval-only", help="comma list of session ids to score (default: the whole set)")
    ap.add_argument("--eval-setup", help="JSON list of commands run once before the eval arms")
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--fast-kernels", action="store_true", help="try fla + causal-conv1d (kept only if exact)")
    ap.add_argument("--transformers", default="5.17.0")
    ap.add_argument("--release", action="store_true", help="cargo build --release nativetools first (not with BUNDLE_NATIVETOOLS)")
    ap.add_argument("--dry", action="store_true", help="accepted and ignored: a build only stages, nothing is uploaded")
    return ap


def main():
    a = parser().parse_args()
    resolve(a)
    if a.continue_from and not a.continue_from.startswith("gs://"):
        sys.exit("--continue-from %s: a gs:// checkpoint directory (run_job.sh pulls it)" % a.continue_from)
    if a.dpo and not a.train:
        sys.exit("--dpo needs --train as well: run_job.sh hands the trainer job.json `train` unconditionally, and train.py scores it "
                 "(the original-data sample of the TRAIN metrics) without training on it")
    if a.dpo and not Path(a.dpo).is_file():
        sys.exit("--dpo %s is not a file" % a.dpo)
    if (a.continue_from or a.dpo) and (a.base or a.ckpt_dir):
        sys.exit("--continue-from / --dpo are training flags: not with --base or --ckpt-dir")
    if a.train and a.ckpt_dir:
        sys.exit("--ckpt-dir is an eval-only job: drop --train")
    if not a.train and not a.base and not a.ckpt_dir:
        sys.exit("build needs --train (or --base / --ckpt-dir for an eval-only run)")
    if a.base and a.no_eval:
        sys.exit("--base with --no-eval would do nothing")
    check_arms(a.arms)
    check_set(a)
    build(a)


if __name__ == "__main__":
    main()
