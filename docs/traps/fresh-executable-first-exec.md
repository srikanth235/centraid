# Trap: a test that writes an executable and runs it on macOS

## What goes wrong

On macOS the **first** exec of a file that was just written waits on the system's code assessment, and the system assesses one file at a time. Measured on the owner's Mac on 2026-10-21 ([#1129](https://github.com/srikanth235/centraid/issues/1129)): a fresh two-line `#!/bin/sh` script took about 500 ms to start the first time and 40 ms the second; sixteen fresh scripts started at once finished over 7.7 s, one after another. A busy machine stretches both.

So a test that writes a fake tool into a temp directory and expects it to have run, or exited, within a fixed few seconds is guessing about every other test on the machine. Under `cargo xtask gate --profile pr`, where nextest runs many test processes at once, `crates/gateway/src/server/bonjour.rs`'s fake-`dns-sd` tests failed this way while passing alone: a fake told to `exit 3` was still unstarted after the test's 3 s window, so the registration it should have refused was taken as made.

A second race rides along: a fake that notes something with `echo … > file` creates the file before it writes into it, so a test that waits for the file to **exist** can read it empty.

## Correct setup

- Wait on a condition, never a sleep: the wait returns the moment the condition holds, and its ceiling only bounds a failure. Give a fake's **first** run a ceiling that covers the assessment queue (the bonjour tests use 60 s); a process already running needs no such allowance.
- Wait for a noted line to be **whole** (it ends in a newline: `echo` writes its line in one `write`), not for the file to exist.
- Production code that watches a child for a window should answer the moment the child exits rather than sleep the window out (`SystemRegistration::start_after`), so a test can pass a long window and pay nothing when the tool fails.
- Prefer a binary the system already ships (`/bin/sh`, `/bin/kill`) where a test can: only freshly written files are assessed.
