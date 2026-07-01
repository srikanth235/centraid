### internal-doc-links

- **Directive**: The internal markdown link graph across tracked `.md` files is healthy. Two sub-checks over the same set of relative markdown links:
    1. **resolve** *(always on)* — every relative-path link target resolves to an existing file. Targets of every kind are checked (other docs, images, scripts, directories), not just `.md`.
    2. **reachable** *(opt-in)* — every tracked `.md` is reachable by following internal links from one of the entry-point ("root") docs declared in `.governance/conf/governance-kit/foundation/internal-doc-links.conf` (`root <path>` / `exclude <glob>` lines). **No-op when the config file is absent or names no roots.** Directive folders, skill asset templates, and eval fixtures are always excluded.
- **Rationale**: `resolve` proves the links you have point somewhere real — a broken link rots silently, the doc still renders but lies, and an agent that follows it bails. `reachable` proves the docs you wrote are on the map — from an agent's point of view a doc no path of links leads to is as invisible as a Slack thread. Together they keep the repo a connected graph rooted at the entry points an agent actually starts from (`AGENTS.md`, `README.md`), not a pile of files only `grep` can find. They share one directive because they parse the same link graph; `resolve` is the always-on minimum while `reachable` is opt-in, because "every doc must be linked" is a policy only some repos want and would otherwise false-positive on receipts, changelogs, and generated docs.
- **Enforced by**: `.governance/packs/governance-kit/foundation/directives/internal-doc-links/check.sh`
- **Exceptions**:
    - *resolve*: line-level waiver — append `<!-- governance: allow-internal-doc-links <reason> -->` (or any comment syntax `grep` sees on the line) to the line with the broken link. Use it for template placeholders or syntax-demonstrating prose, not as long-term cover for rot.
    - *reachable*: a configured `exclude <glob>` line, or a head-of-file comment `governance: allow-internal-doc-links reachable <reason>` in the orphan's first 10 lines (e.g. an intentionally unlinked changelog or generated doc).

    Both are visible in `git blame` and discoverable via `grep -r 'allow-internal-doc-links'`.
