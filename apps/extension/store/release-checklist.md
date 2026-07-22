# Companion release checklist

- Run `bun run --cwd apps/extension test`, `typecheck`, and `package` from a clean checkout.
- Inspect both ZIPs: no source maps, development files, remote script URLs, or unlisted permissions.
- Run the real relay acceptance flow with a fresh gateway and Chrome profile: QR pair, cold and warm fill, receipt context, remote revoke, next-fill refusal.
- Record cold/warm fill timings against the issue #462 budgets (2 s / 0.5 s).
- Load the Firefox ZIP in Firefox 121+ and repeat pairing plus one fill; verify the event-page worker initializes the same WASM binding.
- Publish the privacy policy and permission explanations with the store listing.
- Confirm Safari remains marked unsupported rather than implying compatibility.
