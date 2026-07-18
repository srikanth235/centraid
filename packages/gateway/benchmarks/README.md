# Gateway low-end benchmark

Issue #456's server-side harness runs a real gateway and drives a concurrent,
authenticated mix of journalled Atlas writes and status reads. It records write p50/p99,
peak RSS, event-loop delay, boot fsync latency, filesystem-write operations,
and an idle-window extrapolation for context switches and disk writes per hour.

```sh
bun run perf:gateway
```

The default workload is 120 writes (60 `core.party`, 60 `core.place`) with 30
interleaved reads at concurrency 4, followed by a two-second idle window.
Override the write count with `--requests`, plus `--concurrency` and `--idle-ms`,
after the script name. Linux automatically wraps the child in `strace` when it
is installed, making `fsyncCalls` and `fsyncPerWrite` exact syscall counts.
Unique trace markers bracket only the authenticated measured workload (not
boot, warmup, or shutdown), and split `<unfinished>`/`resumed` syscalls count
once. Fsync totals are divided by the explicit write count, never by reads.
CI sets `CENTRAID_BENCH_REQUIRE_FSYNC=1`, so losing that measurement fails the
gate instead of silently reporting `null`. The traced child emits its raw
report first; the parent injects the scoped syscall count and then applies the
required gate. macOS still reports `fsWrite` and
context-switch counters from `process.resourceUsage()`; exact SQLite fsync
counts require the Linux CI lane because `fs_usage` requires elevated tracing
privileges.

Ceilings live in `low-end-budgets.json`. Lower a ceiling whenever a measured
optimization establishes a smaller stable baseline; never widen one merely to
make a regression pass.

## Issue #456 iteration history

| Run | Request p99 | Throughput | Peak RSS | Event-loop peak p99 | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| Baseline | 381.76 ms | 66.06/s | 156.8 MB | 367.26 ms | request + event-loop fail |
| First pass | 20.62 ms | 388.55/s | 184.3 MB | 173.67 ms | event-loop fail |
| Pre-final | 15.88 ms | 604.19/s | 192.2 MB | 134.02 ms | pass |
| Final pre-audit | 24.73 ms | 265.57/s | 213.1 MB | 24.95 ms | pass |
| Final completed scope | 40.23 ms | 188.55 writes/s | 212.2 MB | 35.03 ms | pass |

The final artifact is `results/issue-456-final.json`. It resets the performance
measurement epoch after authenticated warmup, so app installation and bundle
prewarming remain boot work instead of inflating the measured mixed-workload
event-loop sample. Its workload record makes the 120 writes, two write shapes,
and 30 reads independently auditable. The artifact explicitly forces
`CENTRAID_HARDWARE_PROFILE=constrained`
even though the measurement host has 8 cores and 16 GiB RAM, proving the
low-end defaults rather than merely labeling a standard-host run. The Linux
CI gate repeats that constrained profile with exact strace accounting.
`results/issue-456-runtime.json` records the N7 runtime gate: Node
24.4.1 passes the required `node:sqlite` compatibility probe, while Bun 1.3.13
cannot import that built-in and is therefore a no-go rather than a misleading
partial benchmark.

The full optimization record, architecture decisions, and Rust boundary are in
`docs/plans/gateway-low-end-and-rust-plane.md`.
