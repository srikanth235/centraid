# Permission justifications

- `storage`: retains the paired iroh device identity and non-secret gateway/vault coordinates. Session storage holds the honest UI lock flag. No password, OTP seed, TOTP code, or captured page is cached.
- `alarms`: wakes the MV3 worker periodically to count pending Centraid approvals; it replaces a fragile always-open event stream.
- `contextMenus`: offers the explicit “Capture in Centraid Tasks” selection/page action.
- `activeTab`: reads the title, URL, selection, and visible screenshot only after the owner opens the popup or chooses a capture action.
- `scripting`: injects the local capture helper on demand when the normal Locker content script is unavailable. It never downloads code.
- `http://*/*` and `https://*/*`: Locker must detect sign-in fields and offer origin-matched credentials across sites. The content script runs only in the top frame; insecure public origins fail matching, and cross-origin iframes are excluded.
- `wasm-unsafe-eval` in the extension CSP: Chrome requires this source for the packaged iroh WebAssembly module. `script-src 'self'` still forbids remote-hosted code.

Capture uses `activeTab` and on-demand injection. The broad host access exists solely for Locker form detection, not for passive browsing-history collection.
