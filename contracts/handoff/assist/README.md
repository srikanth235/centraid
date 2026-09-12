# Hand-offs from wave 4's assist lane (#1020)

## `gate.patch` — the `prompt-injection` step

One named `pr` step, `prompt-injection`, plus the two functions behind it
(`run_prompt_injection` and `corpus_size`) — a 61-line addition touching only
`crates/xtask/src/gate.rs`.

**Why it is a patch file.** `crates/xtask` is lane X3's this slot
(§Cross-lane), and two lanes editing one file is how a step goes missing at a
merge. It is applied in this lane's own commit touching nothing else, so the
root can drop that commit and apply this file instead if X3's changes land
first and conflict.

Applied locally as `commit 5 of this lane` — see the receipt.

### The demonstrated red

    $ cargo xtask gate --profile pr   # with contracts/assist/prompt-injection emptied
    ✗ prompt-injection  cargo test -p centraid-assist --test prompt_injection
        the corpus directory contracts/assist/prompt-injection is empty

A missing or emptied corpus is an **error**, never an empty green run: "zero
payloads, all passed" is precisely the failure a gate over a grow-only corpus
has to refuse. The step also prints the payload count on success, so a corpus
that shrank is visible in the gate output rather than only in a diff.
