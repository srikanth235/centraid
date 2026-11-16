# #1200 recovery and fencing source audit

Source audit on `codex/1200-v0-refinement`, followed by documentation/comment clarifications in `.claude/skills/backup/{phone,product}.md`, `crates/core/src/vaults.rs` and `crates/screens/src/backup/reading.rs`. No behavior, wire contract or enforcement changed. No builds, gates or tests were run by this audit.

## E1/E2 current evidence and fit to #1191

The current source matches the signed, per-gateway E4 rule in `contracts/backup/decisions.md:75-85`:

- `crates/core/src/phone/link.rs:302-329` maps `MOVED` to `StoreError::Moved` only when `verify_claim` succeeds for this vault and gateway, and claim epoch is greater than this gateway's held epoch. Otherwise it becomes an ordinary refusal.
- `crates/core/src/phone/drain.rs:623-624` checks whole-door refusal only through `superseded_everywhere`; `drain.rs:724-744` persists a valid takeover on that one gateway row and continues the pass unless all paired gateway rows are moved.
- `crates/core/src/phone/mod.rs:546-575` makes the intended distinction explicit: `moved()` is a status marker when any gateway row is moved; `superseded_everywhere()` refuses only when every row is moved.
- `crates/core/tests/backup_replicas.rs::a_takeover_at_one_gateway_stops_the_pass_there_and_the_other_is_still_fed` exercises a real gateway takeover at A, verifies A's epoch-2 mark, B remains unmarked, and B gets the outbox cleared. `crates/core/src/phone/link.rs::a_moved_is_believed_only_with_a_signed_claim_above_the_epoch_held` checks valid, wrong-key, wrong-gateway, and non-advancing claim shapes.
- `crates/core/tests/restore_edges.rs` covers single-gateway takeover and refusal, concurrent restore winner, multi-step restore chains, refusal of backup handoff after supersession, persistence across reopen, and same-phone recovery. Those tests are broad recovery coverage, but many names/comments still say “freeze” as though it globally prevents vault writes.

`crates/core/tests/phone_backup.rs:861-876` creates a note through `Handle::command` before the old phone contacts the gateway and records any `MOVED` claim. This does not exercise the member action door and does not show that writes are allowed after takeover is learned. Production `crates/core/src/act.rs:69-73,137-139,339-340` derives `moved_epoch` from `phone::moved` (any verified moved gateway row) and refuses both `act` and keyed command writes with `vault_moved`; `crates/core/tests/action_plane.rs::a_frozen_vault_refuses_every_write_and_names_the_check` asserts refusal and no row mutation. The doors have distinct scopes: a backup pass stops only at the gateway that returned a valid claim and continues to other gateways, while ordinary member actions are fenced once any claim is recorded. A local edit made offline before the phone learns of takeover is possible, but remains unconfirmed until a gateway accepts a later backup.

## Stale wording and minimal disposition

There is an actual documentation/API naming contradiction, not a source-path contradiction:

- `contracts/backup/decisions.md:79` scopes the absence of a vault-wide freeze flag to backup pass processing: a claim marks one gateway and other gateways continue; the backup door refuses only when every paired gateway has moved. The separate ordinary `act` door still checks whether any gateway row has moved and refuses member writes after the phone learns of a claim.
- `[.claude/skills/backup/phone.md](/private/tmp/centraid-1200/.claude/skills/backup/phone.md)` previously said the pass refuses if one gateway has a later epoch; its Restore section also described the old phone's next generic write as `MOVED`. The pass description now scopes `MOVED` to the gateway that returned a verified claim and says the whole backup door refuses only after every paired gateway has a moved mark. The Restore section distinguishes that backup behavior from normal action fencing.
- `crates/core/src/vaults.rs` exposes `Vaults::freeze`; `crates/screens/src/vault/shelf.rs:1310-1326` implements it by setting a shelf-local `Moved` record. There is no production caller of `Vaults::freeze`, and this marker is not the source of normal action refusal. `HeldVault.drainable` at `shelf.rs:1246` checks the shelf's `holding.moved` marker; `BackupStatusResponse.frozen` at `crates/core/src/phone/mod.rs:1332` instead comes from `phone::moved(&state)`, which reads the device backup ledger. `act.rs` reads that same device ledger to enforce ordinary action writes. Do not claim the shelf marker's date/count is currently drawn by production UI.

The gateway `FROZEN` operator state in `crates/gateway` is unrelated: it administratively blocks gateway operations and has its own operator tests; do not conflate it with the phone's `Moved` status.

## Existing deterministic tests to run after review

Focused Rust commands proposed for the build lease (not run in this audit). Invoke each through `python3 /private/tmp/centraid-1200-build-guard.py --` from the integration worktree; the wrapper fixes the task target and checks free space/artifact size.

```sh
cargo test -p centraid-core --test backup_replicas a_takeover_at_one_gateway_stops_the_pass_there_and_the_other_is_still_fed
cargo test -p centraid-core --lib a_moved_is_believed_only_with_a_signed_claim_above_the_epoch_held
cargo test -p centraid-core --test restore_edges an_old_phone_learns_it_moved_at_its_first_contact
cargo test -p centraid-core --test restore_edges two_phones_restoring_at_once_end_with_one_writer
cargo test -p centraid-core --test restore_edges a_chain_of_restores_freezes_every_phone_but_the_last
cargo test -p centraid-core --test phone_backup a_restore_brings_every_vault_back_and_the_old_phone_freezes
cargo test -p centraid-core --test action_plane a_frozen_vault_refuses_every_write_and_names_the_check
cargo test -p centraid-vault --test restore_drill
cargo test -p centraid --test restore_drill
```

The test names above show that takeover fencing and in-memory/reopen recovery are covered deterministically. The main missing native proof is an actual shell-level cold reopen with independently provisioned identities and meaningful linked app data; core tests are not a substitute for that evidence.

## Repeatable E1 native recovery drill proposal

Use the iOS simulator path first (same drill can be adapted to Android after platform setup). Never seed from or clone a pre-existing app container. Start with two independently erased simulator app installs/containers: source phone identity A and target phone identity B. Use a dedicated test seed/phrase and fresh gateway data directory for this drill only; do not use `seed-demo-vault` or demo words as evidence. Keep all components local to the machine and make no remote/cloud calls.

1. Start a real local `centraid-gateway` in a fresh temporary data directory using its local CLI; capture the pairing QR/payload on the simulator. Pair source identity A and run a full backup pass. Confirm the gateway is local, pinned, and holds the acknowledged head.
2. Through the native UI, create a small linked dataset: one document with original bytes; create a note in Notes and link that existing note from the document using its existing Add link flow; create a reminder linked to the note. Edit the document and note once so their revision/history rows exist. Record each visible ID and export/record the original document byte length and SHA-256 outside the app container.
3. Wait for the pass to acknowledge the new head and content. Force-quit source app. Cold-launch it and verify the existing source copy is intact before moving on.
4. On an independently initialized target identity/container, use the recovery phrase and gateway pairing payload to restore. Do not copy the source app directory, vault, state DB, spool, secure-store entries, simulator backup, or cached seed. Wait until restore reports checked/complete; cold-quit and relaunch the target.
5. Verify document, note, reminder, both relationships, and history entries in native UI. Fetch the original document bytes and compare exact byte length and SHA-256 with the pre-move record. Run the target backup pass and confirm its acknowledged head.
6. Reopen source A cold while it is still offline from the gateway. If a local edit is accepted before any takeover claim is recorded, record it as an unconfirmed offline change only. Reconnect and run its backup pass; verify it receives the valid `MOVED` claim, the moved gateway is recorded, and the pass continues to any other still-unclaimed gateway. After this claim is recorded, attempt an ordinary native note edit and a notification action; both should be refused by the normal `act` door. Do not use `Handle::command`, raw SQL, or the training harness as proof of member write behavior. Notification actions route through `agenda/notify/answer.rs` and `kit_act::act`, so use the real typed action path.

Suggested fixture/oracle: use the native UI for creation and relationship/history verification, and the existing restore/gateway harness as the deterministic protocol oracle. Do not use a pre-populated app data directory as a “fresh target.” The harness's current `restore_drill` builds a core vault and real local TLS gateway, but does not exercise native UI, cold OS app-container reopen, or the desired document→note→reminder relationships.

## Native prerequisites and available entry points

- Repository instructions in `.claude/skills/land/mobile-commands.md`: iOS requires macOS, Xcode, XcodeGen, Apple SDKs; core rebuild uses `IPHONEOS_DEPLOYMENT_TARGET=$(cat mobile/ios-deployment-target) mobile/scripts/ios-core.sh aarch64-apple-ios-sim`; generate project from `mobile/iosApp/` with `xcodegen generate`; simulator test command is `xcodebuild -project Centraid.xcodeproj -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test`. UI flows run with `maestro test mobile/maestro/flows`.
- Android Compose build needs Android SDK and JDK 21; the committed Maestro flows use the iOS bundle ID. The `mobile/README.md`/`mobile/scripts/demo-vault.sh` flow seeds a demo identity and is unsuitable for independent-identity evidence; no recovery drill UI flow was found.
- Deterministic local gateway entry point: `crates/gateway/src/server/harness.rs` is used by `crates/centraid/tests/restore_drill.rs`; gateway CLI exists under `crates/gateway/src/bin` (inspect `--help` when running, not done here). The restore gate runs both `centraid-vault` memory-store and `centraid` real-gateway drills (`crates/xtask/src/gate.rs:474-532`).
- No physical phone is present in the supplied environment. Simulator/emulator evidence only; no device performance or background scheduling claim. No build, command, or native prerequisite availability was checked in this read-only assignment.

## Ownership recommendation

Smallest follow-up: the stale backup-pass description is corrected in `[.claude/skills/backup/phone.md](/private/tmp/centraid-1200/.claude/skills/backup/phone.md)`. Native recovery evidence still needs an independent-identity restore/cold-reopen flow if simulator setup and secure seeding can be repeated without copying app containers. Preserve the takeover warning and treat the pre-contact `Handle::command` assertion as unrelated to post-contact member-write fencing. No assistant evaluations were run, per scope.
