# Native v0 runtime decisions

## Recurrence

Agenda keeps one canonical `core.event` series row with its RFC 5545 rule. The
read side expands that series into bounded occurrence rows; it does not persist
an unbounded occurrence table. The blueprint query performs this expansion on
the gateway. The native app receives the raw consent-scoped event replica and
runs the same DAILY/WEEKLY/MONTHLY/YEARLY subset locally so month, week, and
agenda views remain instant in airplane mode. Every occurrence retains the
canonical `event_id`; reschedule, RSVP, and cancel therefore always target the
series, while `instanceKey` exists only for rendering.

## Compound camera formats

- Exact SHA-256 is identity. dHash is only a duplicates-review hint and never
  merges assets automatically.
- A Live Photo's HEIC and paired MOV are both read through MediaLibrary,
  durably uploaded, and assigned one stable `capture_group_id`. The lightbox
  finds the companion by that canonical group and plays it on press. Restore
  therefore retains the logical pair even though the OS export API still owns
  reconstruction of a Photos.app compound item.
- Android motion photos, RAW files, and burst members pass through as original
  bytes. v0 does not infer a grouping edge from filenames or timestamps, so it
  cannot corrupt a group through a false match. RAW+JPEG and burst grouping is
  explicitly deferred while both originals remain recoverable.
- Device JPEG derivatives honor decoded orientation through Expo Image
  Manipulator. HEIC and video therefore obtain thumb/preview/poster rungs on
  the device even when the gateway cannot decode the source format.

## Backup and deletion

The upload SQLite file is independent from the disposable replica. Foreground,
Android foreground-service, and lifecycle drains all resume the same
sha-addressed ledger. Wi-Fi and charger rules are queried before each
background item. iCloud originals are requested on demand before enqueueing.

Vault trash never calls MediaLibrary deletion. Free-up-space is the sole UI
that deletes phone originals and admits only rows whose upload ledger has a
settled `casAck` and whose replica asset is merged by exact SHA. The UI shows
the eligible count before the OS confirmation dialog.

## Platform integration

`expo-share-intent` supplies the iOS share extension and Android share target.
Images and videos enter the Photos producer; every other file enters Docs.
Both use the same upload queue and D10 SHA dedupe path. On-this-day and Agenda
reminders are scheduled locally; no APNs, FCM, or push broker is introduced.
