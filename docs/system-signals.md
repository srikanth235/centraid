# Assistant companion and system signals

Centraid presents the household as monitored-for, not monitoring. Healthy state is quiet; a problem becomes prominent only when it needs a member's attention or action. The same mental model holds across the three seats in [blueprint seats](blueprint-seats.md): origin (mobile), custodian (desktop), and viewer (web/PWA).

## Signal ladder

Signals move through four ordered layers:

1. **Ambient** — the Home ribbon, always present and visually recessive when healthy.
2. **Glance** — facts visible in their destination, such as spend or cache pressure; never push.
3. **Push** — a Notification only when a human decision or action is required.
4. **Drill-down** — System or another detail page reached from the signal that made it relevant.

Signal tone is exactly `quiet`, `attention`, or `urgent`. Quiet uses `--text-faint` and a hairline. Attention uses `--attention`; urgent uses `--net`. The two loud tones may colour type, a border, or a 2px rule, never a fill. A healthy subsection is absent when there is nothing useful to say; it does not render a celebratory or empty “all good” panel.

The ribbon leads with each seat's own loss mode:

| Seat | Lead fact | Detail destination |
| --- | --- | --- |
| Origin | content that exists only on this phone | On this phone; urgent loss risk may push to Notifications |
| Custodian | gateway disk and backup health | System, focused on the cause |
| Viewer | replica freshness | read-only System context or an inline retry |

A pushed card states cause, consequence, and exactly one action. The action carries arrival context so the destination focuses the relevant section; a member never has to patrol System to find why they were sent there.

## Destinations

Persisted route ids do not change. Member-facing names and default pins are:

| Existing id | Member-facing destination | Default |
| --- | --- | --- |
| `home` | Home | pinned by law |
| `notifs` / `approvals` | Notifications | pinned |
| `stats` / `insights` | Activity | pinned |
| `data` / `atlas` | Vault | pinned |
| `autos` / `automations` | Automations | More; absent when capability is off |
| `conn` / `connectors` | Connectors | More; absent when capability is off |
| `devices` / `household` | Copies | Vault section with a retained deep link |
| `gateway` | System | never default-pinned; absent from Origin launchers |
| `storage` / phone-storage route | On this phone | Origin only |

Launcher filtering is presentation, not authorization. A deep link to a destination omitted from a seat still resolves and explains where that seat's relevant facts live. Compact navigation shows up to five destinations including Home followed by a standing More control. The default is Home, Alerts, Activity, Vault, More; member pinning may fill the fifth destination without removing More or violating the touch target floor.

Assistant opening is a local frame-state interaction with a 100ms perceived-latency budget from gesture to painted companion. The desktop UI-impact test measures that interval inside the renderer, excluding automation transport latency. Sending paints the member turn and working state synchronously before conversation creation or streaming begins; network first-token latency is reported by the existing run telemetry rather than hidden behind the opening budget.

System renders live host status, backup, capacity, components, logs, and alert history from existing wires. The runtime heartbeat sample ring is process-session data, not durable daily history, so it is not presented as the handoff's 30-day strip. A truthful 30-day strip requires a durable daily availability series; no historical protocol is invented in this integration. Backup signals preserve their cause in the route and order the read-only or actionable Backups facts first on arrival.

## Destination responsibilities

- **Vault** owns Contents, Copies, and Sharing, in that order. The app-bar meta is a custody sentence.
- **Activity** owns runs, spend, distributions, recent receipts, and export. Spend is information, never a danger signal. Custodian can see machine receipts; Origin omits them.
- **System** owns status, heartbeat, current faults, backups, capacity, resource mode, identity, Components, Logs, and Alert history. It is one overview with drill-in pages, not tabs. Viewer is read-only and does not show verbs that can only refuse.
- **On this phone** owns local cache, pending uploads, room, and free-up-space consequences. It never offers to clear content whose only copy is local.

Architecture nouns such as gateway, daemon, component, and replica belong inside System. Other destinations use member language: your vault, this phone, backed up, and up to date.

## Assistant companion

The Assistant route remains the full conversation destination. The companion is a frame surface available from any shared-shell page:

- pointer: a closed Ask pill and an open trailing rail that reserves stage width;
- touch: the existing app-bar entry opens an 86% bottom sheet over a dismissible scrim;
- `⌘J`/`Ctrl+J` toggles it; Escape closes the deepest picker before the companion;
- the current page is included through a removable context chip;
- attachment sources produce removable chips above the composer;
- harness, model, and effort are selected in that order; changing harness resets dependent choices;
- one composer slot is always visible and changes from disabled arrow, to send arrow, to stop.

The consequence line states in words which harness/vendor receives the request and how many things are attached. Network/local badges are not part of this surface. An unavailable harness disables send and explains how to proceed.

## Related

- [Design rulebook](../DESIGN.md)
- [Design machinery](design-machinery.md)
- [Blueprint seats](blueprint-seats.md)
- [Decision register](decisions.md)
- [Issue #785](https://github.com/srikanth235/centraid/issues/785)
