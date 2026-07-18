# Gateway low-end benchmark

Issue #456's server-side harness runs a real gateway and drives a concurrent,
authenticated mix of journalled Atlas writes and status reads. It records write p50/p99,
peak RSS, event-loop delay, boot fsync latency, filesystem activity,
and an idle-window extrapolation for context switches, disk writes, and live
data growth per hour.

```sh
bun run perf:gateway
```

The default workload is 120 writes (60 `core.party`, 60 `core.place`) with 30
interleaved reads at concurrency 4, followed by a 65-second idle window that
covers issue #456's active 30-second and 60-second recurring service cadences.
Override the write count with `--requests`, plus `--concurrency` and `--idle-ms`,
after the script name. Linux automatically runs a second child in `strace` when
it is installed, making `fsyncCalls` and `fsyncPerWrite` exact syscall counts
without contaminating the primary latency, resource, and idle measurements.
Unique trace markers bracket only the authenticated measured workload (not
boot, warmup, or shutdown), and split `<unfinished>`/`resumed` syscalls count
once. Fsync totals are divided by the explicit write count, never by reads.
CI sets `CENTRAID_BENCH_REQUIRE_FSYNC=1`, so losing that measurement fails the
gate instead of silently reporting `null`. The parent injects the scoped
syscall count into the untraced report and then applies the required gate.
Linux gates physical write bytes from `/proc/self/io`; the raw
`process.resourceUsage().fsWrite` value remains diagnostic because its unit is
OS-specific (`ru_oublock` blocks on Linux), not a cross-platform operation
count. macOS still reports that raw counter and context switches; exact SQLite fsync
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
| Completed scope after parse-once router | 40.23 ms | 188.55 writes/s | 212.2 MB | 35.03 ms | pass |
| First Linux traced-primary gate | 40.21 ms | 152.30 writes/s | 170.5 MB | 29.97 ms | fsync pass; OS-counter/ptrace fail |
| Corrected untraced 2s sample | 27.87 ms | 231.09 writes/s | 212.9 MB | 29.77 ms | pass |
| 2s stability recheck | 18.05 ms | 288.15 writes/s | 208.0 MB | 23.10 ms | idle extrapolation fail |
| First Linux 65s gate | 29.21 ms | 224.44 writes/s | 172.2 MB | 26.66 ms | unconfigured WAL spool: 483 MB/hour fail |
| Corrected 65s final | 24.89 ms | 241.25 writes/s | 197.7 MB | 26.94 ms | pass |
| Post-review hardening | 29.46 ms | 247.28 writes/s | 184.3 MB | 10.02 ms | pass |

The final artifact is `results/issue-456-final.json`. It resets the performance
measurement epoch after authenticated warmup, so app installation and bundle
prewarming remain boot work instead of inflating the measured mixed-workload
event-loop sample. Its workload record makes the 120 writes, two write shapes,
30 reads, and 65-second idle observation independently auditable. A two-second
stability recheck varied from 375,859 to 507,421 extrapolated context switches
per hour, so the ceiling stayed fixed and the window was extended to cover the
actual timer cadences. The artifact explicitly forces
`CENTRAID_HARDWARE_PROFILE=constrained`
even though the measurement host has 8 cores and 16 GiB RAM, proving the
low-end defaults rather than merely labeling a standard-host run. The Linux
CI gate repeats that constrained profile with an untraced primary run and
separate exact strace accounting.

The first trustworthy 65-second Linux run exposed a genuine product bug: the
per-vault WAL shipper captured about 8.7 MiB at the unconfigured 60-second RPO,
which extrapolated to 483 MB/hour and accumulated locally because the
unconfigured drain clock was correctly dormant. Unconfigured vaults now leave
capture dormant and use SQLite's 64 MiB autocheckpoint safety net; storage
connection create/delete re-arms capture or the fallback immediately. The
portable live-data-growth gate catches future spool accumulation even on hosts
without `/proc/self/io`.
`results/issue-456-runtime.json` records the reproducible N7 runtime gate. The
committed probe launches both runtimes by default and emits this exact schema;
Node 24.4.1 passes the required `node:sqlite` compatibility probe, while Bun
1.3.13 cannot import that built-in and is therefore a no-go rather than a
misleading partial benchmark.

The full optimization record, architecture decisions, and Rust boundary are in
`docs/plans/gateway-low-end-and-rust-plane.md`.
