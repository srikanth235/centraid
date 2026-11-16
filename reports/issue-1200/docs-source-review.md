# Docs source review

This source-audit slice checked facts against the worktree without running builds or tests. The subsequent combined-tree verification is recorded in `docs-rebuild.md`.

## Member-facing claims

- Contacts are imported on the member's Import action, which may ask for OS access. Following is a separate, per-device coordinator; its passes do not prompt, and a newly restored phone must import once before it follows ([`contacts.rs`](../../crates/screens/src/people/contacts.rs#L21-L34)). Health asks for read access when the member taps Connect; the shell reads only the selected types ([`connect.rs`](../../crates/screens/src/health/connect.rs#L1-L11)). Calendar and Reminders are read by the phone shell; Reminders asks only on the explicit effect and defaults to open reminders ([`PhoneCalendar.swift`](../../mobile/iosApp/Sources/PhoneCalendar.swift#L54-L63), [`PhoneReminders.swift`](../../mobile/iosApp/Sources/PhoneReminders.swift#L4-L20)).
- Android disables OS app-data backup ([`AndroidManifest.xml`](../../mobile/androidApp/src/main/AndroidManifest.xml#L136-L140)). iOS sweeps vault paths and requests backup exclusion, logging failures ([`VaultFileProtection.swift`](../../mobile/iosApp/Sources/VaultFileProtection.swift#L92-L109)); the privacy wording now says “marks … for exclusion,” not that exclusion is guaranteed.
- The recovery-key screen supports opting out of the synced copy or saving it with the platform ([`backup.rs`](../../crates/screens/src/strings/backup.rs#L67-L72)). Android reports Block Store restores only during device setup ([`SecretStores.kt`](../../mobile/androidApp/src/main/kotlin/dev/centraid/android/kit/SecretStores.kt#L63-L75)).
- Backup claims are gated on gateway acknowledgements; it is direct HTTPS with a QR-pinned certificate. Transfer rules are Wi-Fi by default, optional cellular for photos, manual on request, and video originals never cross metered links ([backup product rules](../../.claude/skills/backup/product.md#L3-L5), [transfer rule](../../.claude/skills/backup/product.md#L11)). Restore checks before claiming; MOVED first fences member writes on the old phone but backup can continue to other gateways until all paired gateways moved ([product rule](../../.claude/skills/backup/product.md#L9), [Backups page](../../scripts/docs-site/src/content/backups.html#L43-L44)).
- The public docs are static Cloudflare assets and `wrangler.json` enables observability ([`wrangler.json`](../../wrangler.json#L15-L22)). The docs state only those verified facts and leave observability retention as an owner question in the preserved draft comment.

## Owner review still needed

Privacy remains marked draft. The source comment retains the effective-date, legacy OAuth, jurisdiction-rights, contact-address and Cloudflare observability questions. Terms remains marked draft with its existing clauses, contact, effective date and review comment intact. No new policy or legal promise was added.

## Integrity checks performed

- Existing section IDs remain present in backups, devices, privacy and terms. Ontology rail targets `hero`, `map`, `schema`, `principles` and `rules`, all present as sections.
- The generated ontology schema region is byte-identical to `HEAD`: 85,255 bytes, SHA-256 `6d690d7d60f1c92d81d61e5c4bd9d487219ff1372e504920b6eaacc3c1959697`. No generator was run.
- The ontology map has exactly three `kindgrid` zones, 26 `data-kind` entries, 9 `data-rel` entries, and 26/9/47 `data-count` values. The 9-app diagram names People, Notes, Docs, Calendar, Reminders, Photos, Money, Health and Locker. The test wording expectation matches “three storage groups.”
- `git diff --check` passed for the owned docs files and ontology assertion. No build or test was run.

## Owned paths in this slice

- `scripts/docs-site/src/content/{backups,devices,privacy,terms,404}.html`
- `scripts/docs-site/src/content/{ontology-body.html,ontology-style.css}`
- `scripts/docs-site/src/pages/ontology.astro`
- `crates/vault/tests/ontology_page.rs` (the authorized heading expectation only)
- `reports/issue-1200/docs-source-review.md`
