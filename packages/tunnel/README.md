# @centraid/tunnel

Phone ↔ desktop transport for issue #263: HTTP tunneled over
[iroh](https://www.iroh.computer/) p2p QUIC, the dumbpipe pattern.

The phone runs a tiny localhost HTTP proxy; every WebView request —
documents, ES-module imports, stylesheets, `EventSource('_changes')` — is
forwarded through an iroh bi-stream to the desktop, which forwards it to its
loopback gateway with the bearer attached. The gateway keeps binding
`127.0.0.1` and needs **zero HTTP changes**; the WebView needs **zero
header tricks** (no asset-inliner, no fetch shim).

```
[WKWebView] → http://127.0.0.1:<port> → iroh QUIC (E2E encrypted) → [desktop] → http://127.0.0.1:<gateway>
```

## Auth model

No bearer ever reaches the phone. Devices are authorized by their iroh
**EndpointId** (ed25519 public key) in a named, revocable allowlist
(`DeviceStore`). Pairing is a one-time code: the desktop's "Connect phone"
QR carries `{v: 1, kind: 'centraid-pair', ticket, code}`; the phone dials
the ticket on the pair ALPN, presents the code, and its EndpointId is added
to the allowlist. The code is consumed on first success and expires after
10 minutes. Revoking a device drops its live connections and blocks new
ones at the transport.

## Wire protocol (v1)

Reference implementation: `src/protocol.ts` (Node) — the Swift/Kotlin
implementations in `apps/mobile/modules/centraid-tunnel` must stay in
lockstep with it.

- ALPNs: `centraid/tunnel/1` (HTTP), `centraid/pair/1` (pairing).
- **Header frame**: u32 big-endian byte length, then that many bytes of
  UTF-8 JSON. Max 256 KiB.
- **HTTP**: one QUIC bi-stream per request.
  - Request: header frame `{method, target, headers}` (target = path+query),
    then raw body bytes, then FIN. Bodies are read to end before forwarding
    (bounded at 32 MiB in v0).
  - Response: header frame `{status, headers}`, then raw body bytes
    **streamed** until FIN — SSE events arrive live.
  - Hop-by-hop headers (RFC 9110 §7.6.1) are stripped on both sides; the
    desktop overrides `host` and `authorization`.
  - Tunnel connections from unlisted EndpointIds are closed with QUIC error
    code 401.
- **Pairing**: one bi-stream. Phone sends `{code, deviceName, platform}`
  then FIN; desktop answers `{ok: true, deviceId, desktopName}` or
  `{ok: false, error}` then FIN.

## Spike (Phase 0)

Validated 2026-07-04 under Node 22, Bun, and the Electron 37 main process
(NAPI binding binds, dials, and streams). `scripts/spike-pipe.mjs` drives
the whole loop:

```sh
node scripts/spike-pipe.mjs --local            # one machine, in-process demo gateway
node scripts/spike-pipe.mjs --serve            # desktop role: prints the pair payload
node scripts/spike-pipe.mjs --dial '<payload>' # phone role: localhost proxy → open in a browser
```

Known rough edge: `@number0/iroh@1.0.0` publishes broken `main`/`types`
fields; `src/iroh.ts` loads the entry by deep path and carries its own types
for the subset we use.
