# Protocol and feature contracts (C1–C4)

Policy for gateway ↔ clients (desktop, web, mobile, and the browser extension in [#462](https://github.com/srikanth235/centraid/issues/462)). Settled with issue [#468](https://github.com/srikanth235/centraid/issues/468). **C1–C3 must land before #462** creates the first real old-client / new-gateway skew (C4).

## C1 — Two contracts

### (a) Protocol contract — always

Wire schema changes **never break parsing** in either direction:

| Rule | Detail |
| --- | --- |
| New fields | Optional with defaults on the reader |
| Optional → required | Forbidden without a coordinated floor bump |
| Removed fields | Stay accepted (ignore) until the floor drops them |
| Types | Never narrow (string ↛ enum of fewer values; number ↛ int-only) without a floor |
| Discriminants | Add new union members only as unknown-tolerant or behind a capability |

The handshake and parsers stay green across versions even when a **feature** is unavailable.

### (b) Feature contract — per feature

New product capability requires a **gateway capability flag** (or equivalent version/capability surface).

- Old gateways / clients show a clear **"update the gateway"** / **"update the app"** wall.
- **No fallback paths.** No degraded modes. No defensive branches scattered through feature code that pretend an old host can half-run the new flow.
- Capability detection happens in **exactly one place** (central map / handshake), not re-derived in every screen and route.

**Decided:** no-fallback is confirmed policy, not a proposal. Both ends are under one maintainer pre-1.0; every fallback branch is permanent review tax.

### How the two halves interact

```
parse always succeeds  →  capability check  →  feature runs OR single update wall
```

Never: parse succeeds → feature code branches into three historical shapes.

## C2 — `COMPAT(name)` tagging

Every back-compat shim carries a machine-grepable comment:

```ts
// COMPAT(replica-epoch-v1): added 2026-07-01, drop when floor >= 0.4.0
```

| Required | Meaning |
| --- | --- |
| `name` | Stable id for the shim family |
| `added` | Version or date introduced |
| `drop when floor >= …` | When cleanup is allowed |

**Ban:** untagged `??` / dual-path code that exists only for older peers. One `rg 'COMPAT\('` must produce the complete cleanup backlog.

## C3 — Wire-schema purity

Schemas are **structural declarations only**:

- No transforms, preprocess, or coercion inside the schema definition.
- Normalization is an **explicit post-validation pass** with a named function.
- Tagged unions use **discriminated unions** (one clear discriminant field), not ad-hoc optional field combinations.

Keeps generated clients, docs, and human readers aligned; prevents "schema that is really a parser."

## C4 — Order of work

Land C1–C3 (this doc + code that honors it on the handshake and any new cross-client fields) **before** extension pairing (#462). The extension is the first long-lived client that will lag the gateway in the wild.

## Three numbers on the wire (issue #512)

| Field | Role |
| --- | --- |
| `version` | **Product** semver — display / about only. Clients **must not** refuse connect because product strings differ. |
| `protocolVersion` | Wire protocol integer (CapVer-style). Mutual support window with `minSupportedProtocol`. |
| `minSupportedProtocol` | Oldest protocol this peer still speaks. |
| `schemaEpoch` | Historical alias still emitted (= protocol until vault epoch splits). Fallback if `protocolVersion` absent. |
| `capabilities` | Feature flags (C1) — not product version. |

Handshake (`judgeGatewayInfo`):

```
ok iff peer.protocolVersion >= local.minSupported
     && local.protocolVersion >= peer.minSupported
```

Product skew (desktop 0.6 talking to gateway labeled 0.4) is **allowed** when protocol matches. Surfaces may skip shipping a product version without breaking connect.

Constants live in `@centraid/protocol` (`GATEWAY_VERSION`, `GATEWAY_PROTOCOL_VERSION`, `GATEWAY_MIN_PROTOCOL_VERSION`).

`COMPAT(name)` cleanup floors should cite **protocol** (or capability name), not product semver, when possible.

## Pre-1.0 schema stance (F1)

Until 1.0:

- Prefer optional fields with defaults for forward compatibility.
- **Protocol** floor bumps refuse incompatible peers (update wall), not product string equality.
- Vault DDL / storage **schemaEpoch** in replica code is a storage cursor concept; it may later diverge from wire protocol.
- **1.0** = first release after which every schema change ships a migration ([decisions.md](decisions.md)).

## RPC / API naming (`/centraid/_*` planes)

Issue #504 batch 1. **Mechanical:** route constants live in `@centraid/protocol`; `scripts/lint-protocol-routes.mjs` (via `check:pr`) flags hard-coded known paths in extension + product CLI.

### Plane scheme (de-facto, freeze carefully)

| Prefix | Plane | Role |
| --- | --- | --- |
| `/centraid/_gateway/*` | Shell / control | Info, health, devices, pair, logs, … |
| `/centraid/_vault/*` | Vault | Status, blobs, replica, consent, … |
| `/centraid/_apps/*` | Apps store | List, publish, web-session mint, … |
| `/centraid/_tool/*` | Tools | `centraid_read` / `centraid_write`, … |
| `/centraid/_web/*` | Browser sessions | Control cookie proxy, redeem |
| `/centraid/_agents/*`, `/centraid/_automations/*`, … | Feature planes | Same underscore-plane pattern |

### Rules

1. **No new flat names** under `/centraid/<word>` without a plane underscore segment and a migration plan.
2. Request/response pairs stay under one plane; do not invent parallel `/v2` trees without epoch bump.
3. Clients import `ROUTES` from `@centraid/protocol` rather than string-copying paths.
4. Wire schemas stay structural (C3); normalization is a named post-pass.

## Stream authority

| Channel | Authority | Use |
| --- | --- | --- |
| **Live stream** (SSE / turn stream) | Immediacy | Show tokens and run progress as they happen |
| **Paged / authoritative fetch** | Correctness + catch-up | Conversation history, missed events after reconnect |

Do not treat the live stream as the sole source of truth after a gap — re-fetch authoritative pages. Product CLI streaming is deferred (#504 batch 3 follow-up).

## Related

- [decisions.md](decisions.md) — C1, F1
- [SECURITY.md](../SECURITY.md) — transport trust boundaries
- [ARCHITECTURE.md](../ARCHITECTURE.md) — gateway HTTP surface
- `@centraid/protocol` — version, capabilities, route constants
