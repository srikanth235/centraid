# Centraid data plane

This crate is the issue #456 strangler boundary: TypeScript authorizes and
decides; Rust moves dumb bytes. It is deliberately not a second gateway and
contains no consent, journal, replica, handler, agent, or automation policy.

Components:

- `iroh_relay`: shared native `iroh` 1.x relay core for `centraid/tunnel/1`
  and `centraid/gw-pair/1`. The production entry point is the napi module in
  `packages/tunnel/native`; the CLI `serve-iroh` remains a diagnostic wrapper.
  It asks authenticated gateway control routes to authorize/pair peers, then
  streams request and response bodies between QUIC and loopback HTTP without
  `Array<number>` or JS.
- `serve-http`: ticketed, one-use X-Sendfile-style CAS/static server with
  bounded open ranges; streamed SHA-256 plus off-thread zstd and preview
  workers. Transform and pump routes require the private control secret; the
  authenticated `/v1/pump` streams a local file window to a TS-authorized
  provider URL, so multipart/SigV4 policy remains in the control plane while
  provider I/O and backpressure stay in Rust.
- `seal-cbsf` / `open-cbsf`: CBSF v2 interoperability surface for the sealing
  and hashing pump. Rust authenticates store, zstd, and raw-deflate frames.
- `format`: canonical snapshot JSON, HKDF, AES-GCM, and hashing primitives used
  by the cross-language conformance vectors.

Build and verify:

```sh
cargo test --manifest-path packages/data-plane/Cargo.toml
cargo build --release --manifest-path packages/data-plane/Cargo.toml
```

The HTTP implementation is contract-tested by the gateway's env-switchable
`byte-plane-over-http.test.ts`. Set `CENTRAID_BYTE_PLANE_BASE_URL`,
`CENTRAID_BYTE_PLANE_ROOT`, and `CENTRAID_BYTE_PLANE_SECRET` to run the same
route contract against an already-running implementation; leave the base URL
unset and provide `CENTRAID_BYTE_PLANE_BIN` to spawn this binary.
