# The numbers `cargo xtask measure --write` should write

Measured on `ci-linux-x64-4c` (4 vCPU / 15 GB), JDK 21.0.10, Gradle 9.7.1, Kotlin 2.4.20, on the real `libcentraid_core_ffi.so` from `cargo build -p centraid-core-ffi` over a vault `spike-fixture` founded ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 3 lane E).

## `contracts/ledgers/gate-budgets.json#mobile-jvm`

| Field | Value | How |
| --- | --- | --- |
| `budgetSeconds` | **420** | three consecutive `./gradlew mobileJvm` runs took **91 s, 15 s, 16 s** — the first compiling Kotlin from cold, the other two over a warm Gradle build cache. 420 is roughly four times the cold run, which is what a fresh CI container pays: a Gradle 9.7.1 distribution download, a cold Kotlin compile, a cold `cargo build -p centraid-core-ffi` and the fixture vault. A budget sized on the 16 s warm number would red on the first run of every container, which is the one run that always happens. |
| `kotlinNativeLinkSeconds` | **null, still** | no machine in CI links Kotlin/Native. Filling it with a JVM number would be the one thing the report title exists to prevent. The owner's first `:shared:linkDebugFrameworkIosSimulatorArm64` sets it. |

## The `call` budget for the three screens' reads

p50 and p95 in microseconds, 200 samples each after 50 unmeasured warm-up calls, through JNA against the real cdylib:

| Read                                            | p50        | p95         |
| ----------------------------------------------- | ---------- | ----------- |
| `tally.list` (limit 50 over `tally_expense`)    | 398–494 µs | 563–1177 µs |
| `photos.grid` (limit 120 over `media_asset`)    | 281–410 µs | 381–1085 µs |
| `notes.editor` (limit 30 over `knowledge_note`) | 258–296 µs | 368–394 µs  |

The ranges are five consecutive runs of the same spec on the same machine, and they are quoted as ranges rather than as one number because that is what was measured: a p95 that moves between 563 µs and 1,177 µs on an unloaded 4-vCPU box is the JIT and the scheduler, not the binding. A ledger row set from a single run would red on the next one.

**The proposed ledger ceiling is 3,600 µs** — three times the worst p95 seen across those runs (1,177 µs), as the brief's rule says. The gate's own `call-budget` step holds the Rust side to 50 ms (p95 0.47 ms measured), and the JVM binding is asserted against the SAME 50 ms ceiling in `AbiRoundTripSpec` rather than a looser one: a binding that needed a relaxed ceiling would be a binding the product could not ship.

**These are floors, not device numbers, and the row counts say why.** The fixture vault has 200 rows in `core_party` and none in the three screen tables, so the SQL plan, the protobuf round trip and the JNA marshalling are real and the row copy is not. The device measurement at 50,000 assets is the owner's (`mobile/README.md`).

## The five symbols

| Symbol | Measured | Note |
| --- | --- | --- |
| `centraid_open` | 12.9–13.0 ms | a SQLite open plus the handshake round trip, on an existing file |
| `centraid_call` | see the table above |  |
| `centraid_next_event` | 133–170 µs | the TIMEOUT path, `timeout_ms = 0`, over 100 calls. Allocates nothing (clause 6), which the buffer accounting confirms: it does not move. |
| `centraid_free` | **no number, by contract** | the contract requires it inside the same harvest as the call that allocated, so its cost is already inside `call`. A separate measurement would mean a binding that held a buffer across two calls — the shape clause 1 forbids. |
| `centraid_close` | 2.3–2.9 ms |  |

For comparison, wave 2's spike on the same hardware: C p95 494 µs, JNA p95 894 µs, events 235,817/s. The `mobile/core` binding's p95 is **below** the spike's, which is expected — the spike paged 100 rows over 200 seeded parties and two of these three reads return none.
