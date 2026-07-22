# Centraid Companion

Centraid Companion is the MV3 paired-device surface for a browsing machine that cannot run the gateway. It speaks the existing `centraid/gw-pair/1` and `centraid/tunnel/1` protocols through the checked-in iroh WASM binding.

## Local build

```sh
bun install --frozen-lockfile
bun run --cwd apps/extension build
```

Load `apps/extension/dist` as an unpacked Chrome extension. `bun run --cwd apps/extension package` emits reviewable Chrome and Firefox ZIP files under the ignored `apps/extension/artifacts` directory.

The extension contains no remote-hosted code. Its worker, content script, popup, Public Suffix List data, and WASM module are built into the package. A fresh worker lazily initializes iroh and retains only the paired device identity and gateway/vault coordinates; no Locker secret is cached offline.

## Compatibility

Chrome is the v1 store target. A Firefox 121+ review package consumes the same ESM worker bundle through the dual `background.scripts` / `background.service_worker` manifest and is built on every package run; public Firefox support remains gated on the live pairing/fill check in the release checklist. Safari is explicitly out of scope because its extension packaging, signing, and background runtime require a separate port.

The executable origin contract is `spec/origin-matching-v1.json`; the normative security explanation is `docs/security/locker-origin-matching.md`.
