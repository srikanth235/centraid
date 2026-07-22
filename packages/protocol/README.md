# `@centraid/protocol`

Dependency-free **wire root** for Centraid gateways and clients (issue #504 / #512).

Owns:

- **Product** `GATEWAY_VERSION` (display only)
- **Protocol** `GATEWAY_PROTOCOL_VERSION` / `GATEWAY_MIN_PROTOCOL_VERSION` (connect gate)
- `GATEWAY_SCHEMA_EPOCH` (historical alias; equals protocol until vault epoch splits)
- `GatewayInfo`, `judgeGatewayInfo`, `handshakeGateway`, `protocolsCompatible`
- capability map (`GatewayCapabilities`) returned on `GET /centraid/_gateway/info`
- shared `/centraid/_*` route-path constants

**Types-only** (no runtime schema library). Consumers: gateway, client, extension, product CLI. Do not reverse-depend on gateway or UI packages.

Handshake judges **protocol support window only** — product version skew is not a refuse reason. Features use capabilities (C1).

Route literals that mirror these constants outside this package are flagged by `scripts/lint-protocol-routes.mjs` (part of `check:pr`).
