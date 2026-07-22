# `centraid` (product CLI)

Thin client over the **same** gateway wire protocol as desktop/web/mobile (issue #504 batch 3). Not the daemon admin surface — that remains `centraid-gateway`.

## Auth

| Source | When |
| --- | --- |
| `--token <hex>` | Explicit admin or device token |
| `CENTRAID_TOKEN` | Env override |
| `--data-dir <path>` / `CENTRAID_DATA_DIR` | Reads `<dataDir>/token.bin` (local daemon) |

## Commands

```
centraid status --url http://127.0.0.1:8787 [--token … | --data-dir …]
centraid health --url …
centraid list   --url …          # GET /centraid/_apps
centraid info   --url …          # handshake + capabilities
```

**Streaming** (`attach` / live SSE) is **deferred** to a follow-up under #504 — v1 ships request/response verbs only so the protocol path is proven without half-shipping reconnect.

## Install (workspace)

```
bun run --cwd packages/cli build
bun run --cwd packages/cli test
```

See also [docs/dev-environment.md](../../docs/dev-environment.md).
