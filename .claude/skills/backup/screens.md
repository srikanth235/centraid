# The Backup screens

What the Rust screens draw, and the code that keeps them honest. The wording rule for "backed up" lives in [product.md](./product.md). Code: [`crates/screens/src/backup/`](../../../crates/screens/src/backup/mod.rs). Tests: [`tests.rs`](../../../crates/screens/src/backup/tests.rs) in the same folder.

## Where the numbers come from

- Every screen reads one query, `shell.backup-status`, through `reading::load`. The core answers it from the ledger and dials nobody. A failed read is `Reading::Failed`, never an empty reading. A refresh that fails keeps what was drawn, under one sentence.
- Every time that is a gateway's (acknowledgements, last answered) is the gateway's clock. The phone's clock (`now_ms`) is used only for "2 minutes ago" and for dating notices.
- `Destination::footing` ranks a device worst-first: rolled back, refusing, too large, full, behind, current. Anything but current names the device by the label the member gave it.

## The line (`line.rs`)

- `line()` is a pure function of the reading, whether the vault moved, whether a pass is running and `now_ms`. Home draws the same value, and `tests.rs` proves every sentence without a core.
- It is chosen in this order: vault moved (urgent), no gateway paired, every gateway refusing this phone's token, never acknowledged, then done or records-acknowledged-with-N-waiting.
- "Done" needs the records acknowledged and `unconfirmed() == 0`. "Backing up" is said only while a pass runs. Otherwise the status says what a gateway acknowledged and how many wait.
- Tone is attention when `warns()` finds anything: no acknowledgement, one older than 3 days, a future-dated one, no gateway answering in 3 days, an untrusted gateway, a device told to pair again, any device not current, or an old backlog. The status card's condition uses the same `warns()`, so the card cannot be calm beside a warning line.
- When one device is behind, its name replaces the headline, and `behind_last_good` says what the current devices hold.
- The second clause (`detail`) is bytes from the per-app holdings behind "In this backup": decimal units, rounded down, with videos left out stated. With no per-app rows it falls back to item counts.

## Reasons

- `REASONS` lists the 13 `WaitReason`s in the order the line shows them. One row per reason with a count above zero, each worded by `strings::backup`.
- The reasons come from the core (`phone/drain.rs`). A screen never decides one. Add a reason in `phone.proto`, the core, `REASONS`, `waiting_words`, `row_reason` and the strings together.
- While items wait on `Gateway`, Home browses the local network for the gateway's new address. It runs only with the page and the app in front.

## Home (`home.rs`)

- Rows per gateway lead with how it stands. "Back up now" asks the pass conductor, which runs every pass. The control is enabled only with a gateway paired, a vault that has not moved and no run going. While it runs the reading is re-read every 2 seconds.
- Forget runs off-thread, drops the pairing and revokes this phone's token there. It is refused on a vault that moved.

## Notices (`stale.rs`, `alerts.rs`)

- `backup.alerts` is a view-less service started with the app. It re-reads the ledger on appear, lifecycle, data change and every 6 hours, and offers notices to the one notification service. A failed read leaves the last offer. A moved vault offers nothing.
- Notices are scheduled ahead, from the reading and the clock only. The first is due 3 days after the oldest device's last acknowledgement (or pairing, if it never had one), then at 10 days, then weekly. At most two are offered: the latest due and the next.
- Ids are `backup-stale:<T>:<n>` for that acknowledgement `T`, so a new acknowledgement changes them all. Text claims no reason. A tap opens Backup. The Android channel is its own, `backup`.
- No device paired, or a moved vault, means no notice.

## Check my backup (`check.rs`)

- `backup.check` is pushed from Backup's Recovery section. It asks the core for `CheckBackup` with the member's rule, whether the link is metered (metered if unknown) and whether videos are excluded. It polls progress every second and offers Stop. The work is `phone/check.rs`, described in [phone.md](./phone.md).
- Each device gets a row: opens, will not open, files missing, a file damaged, or not run (Wi-Fi, space, stopped, no backup yet, a backup running, no answer). A device that was not checked is never drawn as a pass.
- No answer from the core is a failure with Retry, not "Not checked".
- A verdict is kept (`opens` or `problem` plus the time, in the device store) only when a backup was actually opened. Backup's row then reads "Checked ... ago" or "Found a problem ... ago", or "Never checked".

## Restore entry

- Backup's restore row is hidden on a moved vault. Pressing it posts Home's restore press, and Home closes its sheet and sends the vault command `Restore`. The vault service (`vault/service.rs`) opens `custody::routes::restore()`, which is `words.enter` with purpose Restore.
- `words.enter` (`custody/enter.rs`) has three purposes. Restore takes 24 words plus a gateway's pairing code. A held seed takes only the pairing code. Re-key takes the words alone.
- The core judges each word as it is typed, and the primary control opens only on a valid phrase and, for a restore, a non-empty pairing code (a held seed needs no phrase).
- A restore asks the owner check first, and warns and goes ahead on a phone with no passcode. A re-key asks nothing. The words are dropped on success and on leaving.
- Outcomes: done (the screen closes), an older backup offered, gateway unreachable, nothing held, not taken, did not check, cannot open, newer build, or a refusal. The offer shows the newest as "will not open" and the older as "opens", and the button names the older date.

## What a member reads of the new backup (`states.rs`, #1191 B16)

- A device's footing now ranks worst-first: older backup, paused, too old, another phone took over. `states::standing_words` is the row's second line for every footing, and `states::notes` adds one line each for an old backup it cannot read, a stored piece found damaged and sent again, and deletes this phone made there that are held for a week ("3 old files go Friday 20 November": the device's date). `states::can_undo` says whether the row offers Undo: held files, a date, and a device that is not paused or moved (an undo is a signed write).
- Another phone took over, paused by whoever runs it, and too old each stop only that device's pass. The line names the worst device ("Office NAS is paused") and the reason under it says what to do. A taken-over vault keeps its urgent line, with "Not you? Ask whoever runs your backup device to pause it." as the reason: the person at the backup device has the last word.
- `Reading.damaged` (the vault's quick check failed) makes the line urgent ("This phone's vault is damaged. No new backup is made."), turns Back up now off and leaves the restore row. A damaged vault is never "Backed up", whatever the last acknowledgement says.
- `states::rate_sentence` says what a check read: "Each check reads {s} of {n} stored pieces, chosen at random. Every piece gets read about once in {m} checks." A check that read every piece says "all". It never says verified. `states::restore_ask` is the sentence a restore asks before it claims anything when it cannot prove it has the newest backup.
- `contracts/backup/states.json` holds every sentence above as a case; `crates/screens/tests/backup_page.rs` reads it and the `promises` rule holds the tests to it. Both shells draw the view state these words make, so the words are one fixture. Not on the wire yet: `Destination.moved/paused/too_old/unreadable_backup/damage_found/held_*` and `Reading.damaged/sample` are filled by the core's reading when row B14 lands, and the rate sentence, the Undo control and the restore ask have no view field to ride until the proto carries them.
