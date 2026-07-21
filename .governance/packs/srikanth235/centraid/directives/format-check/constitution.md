# format-check

Staged files that oxfmt owns must already be formatted.

Formatting is the one gate with no judgement in it: there is exactly one
correct answer and a command that produces it. Leaving it to CI alone means
a round-trip through a red build to discover a missing trailing newline.

The check is scoped to staged files rather than the whole tree. Blocking a
commit on unformatted files the author never opened is how `--no-verify`
becomes muscle memory, and a gate people routinely bypass protects nothing.

**Fix:** `bun run format`

**Waiver:** none. If a file must not be formatted, exclude it from oxfmt's
own configuration, where the exclusion is visible to everyone rather than
buried in a commit message.
