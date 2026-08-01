# Glossary

Authoritative product vocabulary. Prefer these terms in code, docs, commits, and review. When a concept has a canonical type, the pointer is listed.

## Runtime model (never "chat" for the ledger)

| Term | Meaning | Code |
| --- | --- | --- |
| **conversation** | Durable thread. Single-kind: `kind ∈ {chat, build, automation}`. | `packages/app-engine/src/conversation/schema.ts`; tables in `gateway-db.ts` |
| **turn** | One execution under a conversation (`conversation_id` NOT NULL, FK, CASCADE). One reply round for chat; one compile/fire / `ctx.agent` round for automation. | same |
| **item** | Ordered trace element under a turn. `kind ∈ {message_in, step, tool, agent}`. Inbound is `message_in` ordinal 0. | same |
| **run_summary** | Derived VIEW over the ledger for Insights — not a separate write path. | `packages/app-engine/src/stores/gateway-db.ts` |

There is **no `run` layer** and no `run_nodes` table (collapsed in #190). Automation is a conversation whose other side is a deterministic script; its transcript is the same ledger.

### Forbidden synonyms (runtime model)

| Avoid | Use instead | Why |
| --- | --- | --- |
| "chat" for the ledger / schema | **conversation** / **turn** / **item** | Chat is one `conversation.kind`, not the model name |
| "session" for durable agent history | **conversation** | Session often means runner scratch or HTTP session |
| "message" as the unit of agent work | **item** (or `message_in` item) | Messages are one item kind |
| "run" / "run node" as a ledger layer | **turn** / **item** | Pre-#190 vocabulary |
| "thread" as a table name | **conversation** | Informal synonym only |

"Chat" remains fine in **UI copy** ("Ask your vault") and when `conversation.kind === 'chat'`.

## Core product nouns

| Term | Meaning | Code |
| --- | --- | --- |
| **vault** | Sovereign personal ontology for one owner. Unit of custody: `vault.db` + `journal.db` (+ apps/, code/, …). | `packages/vault`; on-disk under `vault/<vaultId>/` |
| **gateway** | Host-agnostic backend that mounts vaults, serves HTTP, runs automation and agent turns. Same core embedded or as `centraid-gateway` daemon. | `packages/gateway` — `buildGateway()`, `serve()` |
| **app** | Installed projection over the vault. Code serves from the release (UI blueprints) or cloned automation sources. Declared handlers in `app.json`. | `packages/app-engine`, `packages/blueprints` |
| **inline app** | An app rendered as a React route **inside the shell** — no iframe, no bridge, replica-backed, offline-capable. The default for the 8 bundled system apps (#505). | `packages/client/src/react/shell/routes/InlineAppRoute.tsx`; registry `inlineApps.ts`; `packages/blueprints/apps/<app>/app-inline.tsx` |
| **served app** | An app rendered as an **opaque, same-origin iframe document** the gateway bakes and serves, under the blueprint CSP. Builder preview + mobile WebViews only since #505. | `packages/app-engine/src/http/static-server.ts`; `AppFrame.tsx` |
| **blueprint** | Shipped template: UI app under `packages/blueprints/apps/` (install-in-place) or automation under `automations/` (clone). | `packages/blueprints` |
| **automation** | Headless conversation + manifest + handler that fires on schedule, webhook, condition, or vault data change. | `packages/automation` |
| **Notifications** | The owner-facing projection that unifies open **decisions** with informational **notices**. It owns no second copy of decision state. | `GET /centraid/_vault/notifications`; `VaultPlane.notificationsSummary()` |
| **decision** | An item that needs the owner to act. Outbox, needs-auth, parked invocation, and scope-request tables remain canonical; Notifications projects them and only these count in its badge. | `VaultPlane.blocking()` |
| **notice** | A durable, non-decision Notifications update. Repeats collapse by `(kind, source_ref)` and carry read/archive state. | `notifications_notice`; `NoticeStore` |
| **reminder** | A due task/event/tally/invite notification with its own schedule and action model. Reminders are not Notifications notices. | `/_reminders/due`; reminder monitors |
| **gateway health** | Live gateway/component **status** — never a Notifications notice (#665). Status is not something the owner can resolve by acting on a card; it lives on the Gateway page (status card, Components tab, durable Alerts history) plus the desktop's threshold-gated OS notification. | `apps/desktop/src/main/gateway-monitor.ts`; `gateway-outage-log-core.ts`; `AlertHistoryPanel` |
| **wake** | Content-free APNs/FCM/Web Push signal that tells a client to fetch locally. A wake never carries a Notifications headline or vault content. | `PushWakeRelay` |
| **handler** | Declared query (read) or action (write) in `app.json`, validated by Ajv, run in a worker with `ctx.vault`. | `packages/app-engine/src/handlers/` |
| **consent / grant** | Owner-signed permission for an app or device to touch vault scopes. | `packages/vault` consent gateway |
| **journal** | `journal.db` — audit/receipt stream **and** conversation ledger bands. | vault package + app-engine `gateway-db.ts` |
| **replica** | Consent-scoped, read-mostly device copy; intents for offline writes; gateway is sole canonical writer. | `packages/vault` replica schema; `packages/client/src/replica/` |
| **pairing** | One-time ticket ceremony that enrolls a device key to a vault over the tunnel. | `packages/gateway` pairing/enrollment stores; `packages/tunnel` |
| **pair ticket** | The **only** ticket kind (#603). Always means _join an existing gateway_. Minted by an owner, one-time, burns on redeem. | `pairing-ticket-codec.ts`; `centraid-gateway pair` |
| **auto-found** | What a gateway does to **itself** when constructed over a **fresh data dir**: creates `Shared` (first, hence the registry default) then `Personal`, and enrols the host device as `admin` on both — silently, with no ceremony, ticket, kit, or screen. An existing data dir is never modified. | `buildGateway()` in `serve/build-gateway.ts`; `VaultRegistry.isFresh()` |
| **Shared / Personal** | The **names** of the two auto-founded vaults, not types. Shared is the household vault new members land in by default; Personal is the founder's, renamed to their display name once the desktop profile step completes (headless keeps `Personal`). | `build-gateway.ts`; rename in `packages/client/src/react/boot.tsx` |
| **member** | A human principal on the gateway — the L2 layer of the auth model (#599). Stable `member_id` + editable label in `gateway.db`; devices bind to a member and inherit its roles. Never a `core_party` row: people-as-_data_ and people-as-_principals_ are separate concepts, and a party row never confers authority. See [Members and roles](#members-and-roles-gateway-599). | `members` / `member_roles` in `gateway-db.ts` |
| **role** | The authority a **member** holds in a vault — what they may **do**: `admin` / `write` / `read`, authored per `(member, vault)`; devices inherit. UI labels: Owner / Member / Viewer. See [Members and roles](#members-and-roles-gateway-599). | `DeviceRole` / `GrantableRole` / `canWrite()` in `enrollment-store.ts` |
| **tunnel / relay** | Iroh QUIC device path; browsers are relay-only (no UDP). | `packages/tunnel`, `packages/tunnel/data-plane` |
| **CAS / custody** | Content-addressed blob store; local-only vs remote-primary lifecycle. | `packages/vault` blob; backup package |
| **skill** | Agent grounding unit (`SKILL.md`) loaded by the agent runtime. | `packages/gateway/src/skills` |
| **design tokens** | Shared colors, type, spacing, icons across desktop/web/mobile. | `packages/design` |
| **receipt** | (1) Vault write receipt id from consent pipeline; (2) repo `receipts/issue-N-*.md` for issue work. | context-dependent |
| **prefs** | Device-level gateway preferences in `gateway.db` — runner, theme, etc. Not the vault owner identity. | `GatewayDatabase.prefRows()` / `setPref()` |

## Hosts and clients

| Term | Meaning |
| --- | --- |
| **desktop** | Electron host; embeds or (policy H1) supervises the local gateway; thin React renderer. `apps/desktop` |
| **web / PWA** | Installable Vite client; no embedded gateway; HTTP or ticket-only Iroh/WASM. `apps/web` |
| **mobile** | Expo client; HTTP/tunnel to a gateway; native Photos/Docs/Agenda over replica. `apps/mobile` |
| **client package** | Shared React shell + browser-safe HTTP. `packages/client` |
| **daemon** | Standalone `centraid-gateway` process under a `dataDir`. |

## Members and roles (gateway, #599)

The auth model has five layers (issue #599): **L0 custody** (the gateway box, landlord bearer, an exported backup recovery kit), **L1 authentication** (devices proving iroh EndpointIds — the only cryptographically provable layer), **L2 principals** (members and agents), **L3 authorization** (`(member, vault) → role`), **L4 attribution** (the journal records the acting member — and the agent when one acted — whenever a principal is known; scheduler-fired automations carry none). Keep the axes in separate words:

- **trust / identity** — is this device _who it claims_? Answered by its proved iroh EndpointId. Nothing to do with authority.
- **member** — _who is acting_? The human behind the device. Devices are pure bindings `(endpoint_id, member_id)`.
- **role** — what may this member _do in this vault_? Authored per `(member, vault)`, revocable; every device the member enrolls inherits it. There is **no per-device role** and no attenuation — a communal device (kitchen iPad) enrolls as its own low-trust member.

| Role | Value | UI label | May do |
| --- | --- | --- | --- |
| admin | `admin` | Owner | Everything `write` may, **plus** invite people, grant roles, revoke devices, remove members. Creating a vault makes you its owner. |
| write | `write` | Member | Read the vault and change it. **The default for every grant**, CLI and UI. |
| read | `read` | Viewer | Read/query only; mutations refused at the gate. |

`revoked` is **not a role** — it is a tombstone state a device binding is put into. It is never granted, never offered in a picker, and deliberately absent from `GrantableRole`.

Invariants:

- **No vault types.** Every vault is a vault with a membership list; "personal" and "shared" are descriptions of that list, never a `type` column or a conversion flow.
- **Narrower vaults over finer roles.** Finer-grained permission wants (per-item visibility, a fourth role tier) are answered with another vault, not with row-level ACLs — the fence against Model B drift (#599).
- **Minting splits by target.** Any member may **self-pair** a new device at their own roles from an already-enrolled device; only a vault's **owners** mint invitations for other people. A ticket is an invitation `(member, [(vault, role)…])` — server-authoritative, one scan, atomic across all grants; the joining device can never name its own member or roles.
- **Two revocation verbs.** _Revoke a device_ leaves the member and their other devices intact; _remove a member_ is one atomic operation that kills all their bindings.
- **Auto-founding** creates the owner's member with no prompt (#603): a fresh data dir gets **Shared** + **Personal**, and the host's own device identity is enrolled as `admin` on both in one transaction. Every vault keeps ≥1 owner, and removing the last owner requires explicit confirmation (`--confirm-last-admin` / `confirmLastAdmin`).
- **Sharing is placement, not filtering.** Data crosses vaults only by projection into an audience vault ("Share to <audience>"), recorded in `core_share_origin`. No one can ever query your vault; what others see is only what was placed where they are.

One deliberate mapping: the vault's `consent_device.trust` (`full`/`readonly`) is a **capability mirror**, not the role. `admin` and `write` both collapse to `full` there, because minting and revoking are gateway-plane concerns the vault has no opinion about.

## Forbidden / discouraged synonyms (broader)

| Avoid | Prefer |
| --- | --- |
| "database" for the personal ontology | **vault** (`vault.db` is the file) |
| "server" for the product backend | **gateway** |
| "template app" after install | **app** (blueprint is the shipped source) |
| "plugin" for declared handlers | **handler** / **query** / **action** |
| "identity.sqlite" / multi-user gateway identity | vault owner _is_ the user (#280) |
| `owner` as a **device** role | **`admin`** — the owner is the human; a device is never the owner |
| `full` as a device role | **`write`** — "full" is a lie once `admin` sits above it |
| "trust" / "trust tier" for what a device may do | **role** — trust is proved identity, role is granted authority |
| "space" / "spaces" in user-facing copy | **vault** / **vaults** — one word, everywhere the owner can read it. The sidebar switcher ([`gatewaySwitcher.ts`](../packages/client/src/react/shell/gatewaySwitcher.ts), eyebrow "Vaults", aria-label "Vaults") lists **vaults only** — flattened across every registered gateway (#665) — changes the active/default vault pointer (switching gateway too when the vault is hosted elsewhere), and is always present so Add vault remains reachable. The sidebar identity row reads "… Switch vault or gateway." ([`IdentityHead.tsx`](../packages/client/src/react/shell/IdentityHead.tsx), ⌘⇧G in [`App.tsx`](../packages/client/src/react/shell/App.tsx)); Settings → **Vault** ([`SettingsVaultScreen.tsx`](../packages/client/src/react/screens/SettingsVaultScreen.tsx)); Household → **Vaults** ([`HouseholdScreen.tsx`](../packages/client/src/react/screens/HouseholdScreen.tsx)); mobile switcher → **Vaults** ([`VaultsSwitcher.tsx`](../apps/mobile/src/screens/home/VaultsSwitcher.tsx)). Code identifiers were renamed to match on 2026-07-31 (#665): `Vault*` components, `vault`/`vaults` props, the `vault` settings-page id, `data-vault-id`, and the mobile `vaults.*` storage keys. |
| **gateway** as an end-user _management_ noun | there isn't one (#665). **Every noun the owner manages is a vault**; a gateway is plumbing. Each surface has exactly one job: the switcher **switches** vaults (no overflow menus, no management affordances); a vault's own Settings → **Vault** page manages that vault, including **Disconnect** under "On this device" — offered only when the active vault sits on a _remote_ connection, since the primordial `local` gateway is this machine; and host plumbing (Test connection / Rename / Remove) lives in the **Connections** section of Gateway → Components ([`SettingsDiagnosticsScreen.tsx`](../packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx)), the one surface where a machine is legitimately the subject and the word "gateway" may appear. There is deliberately **no** Settings → Gateways page. |
| "remove the gateway" in _disconnect_ copy | **disconnect the vault** — the primitive (`removeGateway`) is connection-wide, so the confirm NAMES every sibling vault that goes with it and promises the vaults survive on their host ([`disconnectConfirmCopy`](../packages/client/src/react/shell/gatewayRegistry.ts)). Per-vault forget does not exist; it would be a server-side grant revocation. |
| "user" / "account" for a household principal | **member** — there are no accounts, passwords, or sessions; a member is a principal on the enrollment plane (#599) |
| "token" for the pairing artifact | **ticket** — one-time, burns on redemption (#555 removed bearer redemption) |
| "founding ticket" / "founding ceremony" / "recovery-kit ceremony" / "uninitialized gateway" | **auto-found** — #603 deleted the founding plane entirely. A gateway is never zero-vault, and "ticket" now means the **pair ticket**, unqualified |
| "found a vault" as something a **user** does | the user **creates** a vault (an admin act on a running gateway); only the **gateway** founds — itself, once, on a fresh data dir |
| "Approvals" or "Inbox" for the unified owner surface | **Notifications** (#665) — "Inbox" reads as mail, and this stream is news plus things needing action. Use **decision** when referring specifically to an item waiting on the owner, and **notice** for a durable non-decision update. |
| `com.centraid.*` identifiers | **`dev.centraid.*`** ([identifiers.md](identifiers.md)) |

## Inconsistencies (known dual vocabulary)

These pairs appear in code and docs for historical reasons. Prefer the **canonical** term in new writing; the other is tolerated in existing APIs until renamed with a migration.

| Dual | Prefer | Tolerate | Notes |
| --- | --- | --- | --- |
| host / gateway | **gateway** for the product process | "host" in host-agnostic package comments | Desktop "hosts" the embed; the product backend is the gateway |
| profile / gateway id | **gateway id** in multi-gateway switcher | "profile" in older settings paths | Same durable folder under `gateways/<id>/` |
| chat / conversation | **conversation ⊃ turn ⊃ item** | "chat" only in UI copy | Ledger model forbids "chat" as the technical term |
| template / blueprint | **blueprint** for shipped source | "template" in gallery UI | After install it is an **app** |
| server / gateway | **gateway** | HTTP "server" for the listener socket |  |
| Approvals / Inbox / Notifications | **Notifications** in UI labels, docs, wire names, and identifiers | `Approvals*` file/component names, the `approvals` route kind, and mobile nav routes | Approvals → Inbox in #647, Inbox → **Notifications** in #665 (copy, identifiers, `/_vault/notifications` routes, `notifications_notice` table). The remaining `Approvals*` identifiers await a mechanical rename |
| space / vault | **vault** everywhere — copy, docs, and identifiers | none | Copy swept, then identifiers mechanically renamed on 2026-07-31 (#665): `Space*` → `Vault*`, `space`/`spaces` props → `vault`/`vaults`, settings-page id `"space"` → `"vault"`, `data-space-id` → `data-vault-id`, mobile `spaces.*` storage keys → `vaults.*`, and the mobile device-local registry (`lib/spaces.ts`) → `lib/vault-links.ts` with `VaultLink` symbols (distinct from `lib/gateway.ts`'s server-side `listVaults`/`VaultRow`) |

**Mechanical vs judgment:** judgment-only (no synonym linter yet).

## Related

- Runtime model detail: [ARCHITECTURE.md](../ARCHITECTURE.md)
- Identifier table: [identifiers.md](identifiers.md)
- Decisions: [decisions.md](decisions.md)
