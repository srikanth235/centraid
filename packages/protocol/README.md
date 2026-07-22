# `@centraid/protocol`

Dependency-free **wire root** for Centraid gateways and clients (issue #504 batch 2).

Owns:

- `GATEWAY_VERSION` / `GATEWAY_SCHEMA_EPOCH`
- `GatewayInfo`, `judgeGatewayInfo`, `handshakeGateway`
- capability map (`GatewayCapabilities`) returned on `GET /centraid/_gateway/info`
- shared `/centraid/_*` route-path constants

**Types-only** (no runtime schema library). Consumers: gateway, client, extension, product CLI. Do not reverse-depend on gateway or UI packages.

Route literals that mirror these constants outside this package are flagged by `scripts/lint-protocol-routes.mjs` (part of `check:pr`).
