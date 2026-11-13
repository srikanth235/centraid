"""The job file: everything one training run is told, validated before anything is downloaded or paid for.

`train --config job.json` reads one JSON object. Unknown keys are refused (a typo is a different run), the base model's revision must
be a commit hash (a branch name moves), and the adapter's targets must be modules the llama.cpp converter at the commit the phone's
engine vendors can ship (`SHIPPABLE`): the adapter is useless if it cannot be written as a GGUF.

    {
      "name": "adapter-v1",
      "base": {"model": "Qwen/Qwen3.5-0.8B", "revision": "<40 hex>", "weights": "hf"},
      "lora": {"rank": 16, "alpha": 32, "dropout": 0.0, "targets": [...]},          # targets optional: DEFAULT_TARGETS
      "data": {"train": "s3://b/train.jsonl.zst", "val": "s3://b/val.jsonl.zst"},   # optional "train_sha256", "val_sha256"
      # or a data version on the private Hugging Face dataset, pinned (never a branch; train and val only, never test):
      "data": {"hf": "hf://datasets/srikanth235/centraid-native-data@v0.2"},          # token: HF_TOKEN (or HF_TOKEN_SECRET_ID on AWS), never here
      "data": {"hf": "...@v0.2", "subset": "NAME"},                                   # a nested train subset: data/NAME.jsonl.zst instead of train
      "checkpoints": "s3://b/run/checkpoints",                                        # a path, s3:// or gs:// prefix
      "outputs": "s3://b/run/outputs",
      "train": {"seed": 0, "lr": 2e-4, "bs": 8, "steps": 1000, ...}
    }

The three storage locations (`data`, `checkpoints`, `outputs`) are the only thing that differs between AWS, Modal and GCP.

Imports nothing outside the standard library.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field

SCHEMES = ("s3", "gs", "")  # "" = a local or mounted path

# Modules of Qwen3.5's language model the llama.cpp converter ships in a LoRA GGUF (HF name -> GGUF tensor), checked against
# conversion/qwen.py, convert_lora_to_gguf.py and gguf-py's tensor map at the pinned commit (the spike of #1188).
SHIPPABLE = {
    "q_proj": "attn_q", "k_proj": "attn_k", "v_proj": "attn_v", "o_proj": "attn_output",           # the 6 full-attention blocks
    "in_proj_qkv": "attn_qkv", "in_proj_z": "attn_gate", "out_proj": "ssm_out",                    # the 18 linear-attention blocks
    "gate_proj": "ffn_gate", "up_proj": "ffn_up", "down_proj": "ffn_down",                         # the FFN of all 24
    "in_proj_a": "ssm_alpha", "in_proj_b": "ssm_beta",                                              # shippable, 1024x16: opt-in only
}
OPT_IN = ("in_proj_a", "in_proj_b")
DEFAULT_TARGETS = tuple(t for t in SHIPPABLE if t not in OPT_IN)
# Never an adapter target, with the reason the message gives.
REFUSED = {
    "embed_tokens": "embeddings stay frozen and no tokens are added (the converter refuses an adapter that carries them)",
    "lm_head": "the head is tied to the embedding, which stays frozen",
    "token_embd": "embeddings stay frozen",
}
WEIGHTS = ("hf", "q4_0_dequantised")
SHA = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class ConfigError(ValueError):
    """The job file is wrong; nothing was started."""


@dataclass(frozen=True)
class Lora:
    rank: int = 16
    alpha: int = 32
    dropout: float = 0.0
    targets: tuple[str, ...] = DEFAULT_TARGETS


@dataclass(frozen=True)
class Schedule:
    seed: int = 0
    lr: float = 2e-4
    bs: int = 8
    steps: int = 1000
    warmup: int = 20
    max_len: int = 4096
    checkpoint_every: int = 100
    keep_checkpoints: int = 2
    eval_every: int = 0  # 0 = only at the end
    grad_clip: float = 1.0


@dataclass(frozen=True)
class Job:
    name: str
    base_model: str
    base_revision: str
    base_weights: str
    base_gguf: str | None
    lora: Lora
    train: str | None
    val: str | None
    train_sha256: str | None
    val_sha256: str | None
    checkpoints: str
    outputs: str
    hf: str | None = None
    with_val: bool = True
    subset: str | None = None
    schedule: Schedule = field(default_factory=Schedule)
    raw: dict = field(default_factory=dict, compare=False)

    def digest(self) -> str:
        """sha256 of the job file as canonical JSON: what the run record names the run by."""
        return hashlib.sha256(json.dumps(self.raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _only(obj, allowed, where):
    if not isinstance(obj, dict):
        raise ConfigError("%s must be an object" % where)
    extra = sorted(set(obj) - set(allowed))
    if extra:
        raise ConfigError("%s: unknown key %s (allowed: %s)" % (where, ", ".join(extra), ", ".join(sorted(allowed))))
    return obj


def _location(value, where):
    if not isinstance(value, str) or not value.strip():
        raise ConfigError("%s must be a path, s3:// or gs:// location" % where)
    scheme = value.split("://", 1)[0] if "://" in value else ""
    if scheme not in SCHEMES:
        raise ConfigError("%s: unsupported location %r (use a path, s3:// or gs://)" % (where, value))
    if scheme and not value.split("://", 1)[1].strip("/"):
        raise ConfigError("%s: %r names no bucket" % (where, value))
    return value


def targets_of(raw) -> tuple[str, ...]:
    """The validated adapter targets. Embeddings and the head are refused with their reason; a name the converter cannot ship is refused."""
    if not isinstance(raw, (list, tuple)) or not raw:
        raise ConfigError("lora.targets must be a non-empty list")
    out = []
    for t in raw:
        if t in REFUSED:
            raise ConfigError("lora.targets: %s is never a target: %s" % (t, REFUSED[t]))
        if t not in SHIPPABLE:
            raise ConfigError("lora.targets: %r is not a module the converter can ship (use: %s)" % (t, ", ".join(SHIPPABLE)))
        if t not in out:
            out.append(t)
    return tuple(out)


def target_regex(targets) -> str:
    """The peft `target_modules` regex (peft full-matches a string): these modules at `layers.N.<self_attn|linear_attn|mlp>.<module>`, which is
    the language model's path; the vision tower's blocks (`visual.blocks.N.attn.qkv`) never match, and neither do embeddings or the head."""
    names = "|".join(sorted(re.escape(t) for t in targets))
    return r".*layers\.\d+\.(self_attn|linear_attn|mlp)\.(%s)" % names


def parse(obj: dict) -> Job:
    top = {"name", "base", "lora", "data", "checkpoints", "outputs", "train"}
    _only(obj, top, "job")
    missing = sorted(k for k in ("name", "base", "data", "checkpoints", "outputs") if k not in obj)
    if missing:
        raise ConfigError("job: missing %s" % ", ".join(missing))
    name = obj["name"]
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}", name):
        raise ConfigError("name must be 1-63 characters of letters, digits, '.', '_' and '-'")
    base = _only(obj["base"], {"model", "revision", "weights", "gguf"}, "base")
    for k in ("model", "revision"):
        if k not in base:
            raise ConfigError("base.%s is required" % k)
    if not SHA.match(str(base["revision"])):
        raise ConfigError("base.revision must be a 40-character commit hash (a branch or tag moves under the run)")
    weights = base.get("weights", "hf")
    if weights not in WEIGHTS:
        raise ConfigError("base.weights must be one of %s" % ", ".join(WEIGHTS))
    gguf = base.get("gguf")
    if weights == "q4_0_dequantised" and not gguf:
        raise ConfigError("base.weights 'q4_0_dequantised' needs base.gguf (the phone's Q4_0 file)")
    if weights == "hf" and gguf:
        raise ConfigError("base.gguf is only read with base.weights 'q4_0_dequantised'")
    lo = _only(obj.get("lora", {}), {"rank", "alpha", "dropout", "targets"}, "lora")
    rank, alpha, dropout = lo.get("rank", 16), lo.get("alpha", 32), lo.get("dropout", 0.0)
    if not (isinstance(rank, int) and not isinstance(rank, bool) and 1 <= rank <= 256):
        raise ConfigError("lora.rank must be an integer from 1 to 256")
    if not (isinstance(alpha, int) and not isinstance(alpha, bool) and alpha > 0):
        raise ConfigError("lora.alpha must be a positive integer")
    if not (isinstance(dropout, (int, float)) and 0.0 <= dropout < 1.0):
        raise ConfigError("lora.dropout must be in [0, 1)")
    lora = Lora(rank, alpha, float(dropout), targets_of(lo["targets"]) if "targets" in lo else DEFAULT_TARGETS)
    data = _only(obj["data"], {"train", "val", "train_sha256", "val_sha256", "hf", "with_val", "subset"}, "data")
    if "hf" in data:
        from . import hf  # noqa: PLC0415 - hf imports this module's ConfigError

        if "train" in data or "val" in data:
            raise ConfigError("data: give either hf or train/val locations, not both")
        hf.parse(data["hf"])
        hf.train_path(data.get("subset"))
        if not isinstance(data.get("with_val", True), bool):
            raise ConfigError("data.with_val must be true or false")
    elif "train" not in data:
        raise ConfigError("data.train (or data.hf) is required")
    elif "with_val" in data or "subset" in data:
        raise ConfigError("data.with_val and data.subset go with data.hf")
    for k in ("train_sha256", "val_sha256"):
        if data.get(k) is not None and not HEX64.match(str(data[k])):
            raise ConfigError("data.%s must be 64 lowercase hex characters" % k)
    sched_keys = set(Schedule.__dataclass_fields__)
    sc = _only(obj.get("train", {}), sched_keys, "train")
    schedule = Schedule(**sc)
    for k in ("bs", "steps", "max_len", "checkpoint_every", "keep_checkpoints"):
        v = getattr(schedule, k)
        if not (isinstance(v, int) and not isinstance(v, bool) and v >= 1):
            raise ConfigError("train.%s must be a positive integer" % k)
    if not (isinstance(schedule.lr, (int, float)) and schedule.lr > 0):
        raise ConfigError("train.lr must be positive")
    has_val = bool(data.get("val")) or ("hf" in data and data.get("with_val", True))
    if schedule.eval_every and not has_val:
        raise ConfigError("train.eval_every needs data.val")
    return Job(
        name=name, base_model=str(base["model"]), base_revision=str(base["revision"]), base_weights=weights, base_gguf=gguf, lora=lora,
        train=_location(data["train"], "data.train") if "train" in data else None,
        val=_location(data["val"], "data.val") if data.get("val") else None,
        hf=data.get("hf"), with_val=data.get("with_val", True), subset=data.get("subset"),
        train_sha256=data.get("train_sha256"), val_sha256=data.get("val_sha256"),
        checkpoints=_location(obj["checkpoints"], "checkpoints"), outputs=_location(obj["outputs"], "outputs"),
        schedule=schedule, raw=obj,
    )


def loads(text: str) -> Job:
    try:
        return parse(json.loads(text))
    except json.JSONDecodeError as e:
        raise ConfigError("the job file is not JSON: %s" % e) from e
