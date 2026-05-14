### no-broken-internal-doc-links

- **Directive**: Every relative-path markdown link in a tracked `.md` file resolves to an existing file.
- **Rationale**: Broken links rot silently — the doc still renders, just incorrectly. A link that once pointed at a real file and now doesn't signals that the doc has drifted from the code it describes.
- **Enforced by**: `.governance/packs/governance-kit/core/directives/no-broken-internal-doc-links/check.sh`
- **Exceptions**: Line-level waiver — append `<!-- governance: allow-no-broken-internal-doc-links <reason> -->` to the same line as the broken link (or to any other markdown comment syntax that grep sees on that line). The waiver is visible in `git blame` and discoverable by `grep -r 'allow-no-broken-internal-doc-links'`; use it for known-intentionally-broken examples (template placeholders, link prose that demonstrates a syntax) rather than as long-term cover for real rot.
