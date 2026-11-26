"""Copy the security-review skills Centraid uses into general/.

    python3 .claude/skills/stack/security/sync.py trailofbits=<checkout> getsentry=<checkout>
        copy from checkouts of https://github.com/trailofbits/skills and
        https://github.com/getsentry/skills (every upstream is required each sync)
    python3 .claude/skills/stack/security/sync.py --check
        verify general/ against the lists below, offline

Files are copied verbatim: each skill's whole folder, so
general/<upstream>/<skill>/ holds SKILL.md and its references, agents, assets
and scripts as upstream has them. Nothing is rewritten by hand (the Trail of
Bits licence, CC BY-SA 4.0, forbids passing off an adaptation as the original).
The one change: a relative link to a file that is not taken becomes a link to
that file upstream, at the synced commit. To take or drop a skill, edit the
lists and run the sync; never edit general/ by hand.
"""
import os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "general")

# Per upstream: where it lives, its licence file (copied to licenses/), and
# the skills taken, as {name: folder in the upstream repo}.
#
# Trail of Bits: rust-review for the Rust crates, supply-chain-risk-auditor
# for a new dependency, sharp-edges for API and config design, and
# property-based-testing for the pure rules. A skill's own folder is copied
# whole, scripts included (they are text; nothing is run from here). What
# sits next to the skill in its plugin (rust-review's prompts, agents and
# scripts, plugin evals) is not taken: links to it point upstream.
# Sentry: gha-security-review for `.github/workflows/`.
# Left out on purpose: every other Trail of Bits skill (C, C++, Solidity,
# Python, Semgrep and CodeQL authoring, reverse engineering and the rest do
# not match our stack), and the other Sentry skills.
UPSTREAMS = {
    "trailofbits": {
        "url": "https://github.com/trailofbits/skills",
        "licence_file": "LICENSE",
        "licence_name": "CC BY-SA 4.0",
        "licence_copy": "trailofbits-skills-LICENSE",
        "skills": {
            "rust-review": "plugins/rust-review/skills/rust-review",
            "supply-chain-risk-auditor": "plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor",
            "sharp-edges": "plugins/sharp-edges/skills/sharp-edges",
            "property-based-testing": "plugins/property-based-testing/skills/property-based-testing",
        },
    },
    "getsentry": {
        "url": "https://github.com/getsentry/skills",
        "licence_file": "LICENSE",
        "licence_name": "Apache-2.0",
        "licence_copy": "getsentry-skills-LICENSE",
        "skills": {"gha-security-review": "skills/gha-security-review"},
    },
}

LINK = re.compile(r"\]\(([^)\s#]+)(#[^)\s]*)?\)")
SKIP_DIRS = {"__pycache__", ".git", "node_modules"}
SKIP_FILES = {".DS_Store"}


def taken_dirs(up):
    return [p for p in UPSTREAMS[up]["skills"].values()]


def is_taken(up, repo_rel):
    return any(repo_rel == d or repo_rel.startswith(d + "/") for d in taken_dirs(up))


def walk(top):
    for dp, dns, fs in os.walk(top):
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS)
        for f in sorted(fs):
            if f not in SKIP_FILES:
                yield os.path.join(dp, f)


def rewrite(text, up, repo_rel, root, commit):
    base = UPSTREAMS[up]["url"]

    def fix(m):
        target, frag = m.group(1), m.group(2) or ""
        if re.match(r"^[a-z]+:", target) or target.startswith("/"):
            return m.group(0)
        resolved = os.path.normpath(os.path.join(os.path.dirname(repo_rel), target))
        if resolved.startswith(".."):
            return m.group(0)
        full = os.path.join(root, resolved)
        if not os.path.exists(full):
            # Not a real link (an example in prose or code): leave it be.
            return m.group(0)
        if is_taken(up, resolved):
            return m.group(0)
        kind = "tree" if os.path.isdir(full) else "blob"
        return f"]({base}/{kind}/{commit}/{resolved}{frag})"
    return LINK.sub(fix, text)


def description(text):
    m = re.search(r"^description:[ \t]*(.*)$", text, re.M)
    if not m:
        h = re.search(r"^#\s+(.+)$", text, re.M)
        return h.group(1).strip() if h else ""
    first = m.group(1).strip()
    if first[:1] in (">", "|"):
        out = []
        for line in text[m.end():].splitlines()[1:]:
            if line and not line[0].isspace():
                break
            if line.strip():
                out.append(line.strip())
        return " ".join(out)
    return first.strip("\"'")


def sync(checkouts):
    if set(checkouts) != set(UPSTREAMS):
        sys.exit(f"give a checkout for each of: {' '.join(UPSTREAMS)}")
    commits = {}
    for up, co in checkouts.items():
        commits[up] = subprocess.check_output(["git", "-C", co, "rev-parse", "HEAD"], text=True).strip()
        missing = [n for n, p in UPSTREAMS[up]["skills"].items() if not os.path.isfile(os.path.join(co, p, "SKILL.md"))]
        if missing:
            sys.exit(f"{up}: not upstream (moved or removed): {missing}")
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(os.path.join(HERE, "licenses"), exist_ok=True)
    counts = {}
    lines = [
        "# Security review skills: index",
        "",
        "Generated by `sync.py`; do not edit. Links to files not taken point upstream.",
        "Read [../centraid.md](../centraid.md) first: it says when to use each skill and where Centraid's own rules win.",
    ]
    for up, co in checkouts.items():
        cfg, commit = UPSTREAMS[up], commits[up]
        for name, path in cfg["skills"].items():
            top = os.path.join(co, path)
            for src in walk(top):
                repo_rel = os.path.relpath(src, co)
                dst = os.path.join(OUT, up, name, os.path.relpath(src, top))
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if src.endswith(".md"):
                    open(dst, "w").write(rewrite(open(src).read(), up, repo_rel, co, commit))
                else:
                    shutil.copy(src, dst)
                counts[up] = counts.get(up, 0) + 1
        shutil.copy(os.path.join(co, cfg["licence_file"]), os.path.join(HERE, "licenses", cfg["licence_copy"]))
        lines += [
            "",
            f"## {up}",
            "",
            f"Source: {cfg['url']} at `{commit[:12]}`, {cfg['licence_name']} ([licence](../licenses/{cfg['licence_copy']})).",
            "",
            "| Skill | Use it to |",
            "| --- | --- |",
        ]
        for name, path in cfg["skills"].items():
            d = description(open(os.path.join(co, path, "SKILL.md")).read())
            lines.append(f"| [{name}]({up}/{name}/SKILL.md) | {d.replace('|', '/')} |")
    lines.append("")
    open(os.path.join(OUT, "INDEX.md"), "w").write("\n".join(lines))
    print("; ".join(f"{u}: {len(UPSTREAMS[u]['skills'])} skills, {n} files from {commits[u][:12]}" for u, n in counts.items()))


def check():
    errors = []
    if not os.path.isdir(OUT):
        sys.exit("security skills: general/ is missing; run the sync")
    have = {os.path.relpath(p, OUT) for p in walk(OUT)}
    allowed = {f"{up}/{n}" for up, c in UPSTREAMS.items() for n in c["skills"]}
    for up, c in UPSTREAMS.items():
        for n in c["skills"]:
            if f"{up}/{n}/SKILL.md" not in have:
                errors.append(f"missing {up}/{n}/SKILL.md")
        if not os.path.exists(os.path.join(HERE, "licenses", c["licence_copy"])):
            errors.append(f"missing licenses/{c['licence_copy']}")
    for p in sorted(have):
        if p != "INDEX.md" and "/".join(p.split("/")[:2]) not in allowed:
            errors.append(f"not in the lists (remove it or add it and sync): {p}")
    index = open(os.path.join(OUT, "INDEX.md")).read() if "INDEX.md" in have else ""
    for up, c in UPSTREAMS.items():
        if f"## {up}" not in index:
            errors.append(f"INDEX.md has no section for {up}")
        for n in c["skills"]:
            if f"({up}/{n}/SKILL.md)" not in index:
                errors.append(f"INDEX.md does not list {up}/{n}")
    for e in errors:
        print("security skills:", e, file=sys.stderr)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args == ["--check"]:
        check()
    elif args and all("=" in a for a in args):
        sync(dict(a.split("=", 1) for a in args))
    else:
        sys.exit(__doc__)
