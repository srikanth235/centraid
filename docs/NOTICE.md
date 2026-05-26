# Third-party notices

## Documentation site renderer (`scripts/docs-site/`)

The static-site renderer under [`scripts/docs-site/`](../scripts/docs-site/) is derived from the [openclaw/docs](https://github.com/openclaw/docs) project at commit [`277d774`](https://github.com/openclaw/docs/tree/277d7740cba35423143d51a7587e1313e9afe758) (MIT-licensed).

Centraid's adaptations:

- Stripped the multi-locale machinery (translation memory files, per-locale navigation overlays, Mintlify locale sync). Single-locale English-only.
- Removed the Cloudflare R2 + Worker publish pipeline (`r2-prepare.mjs`, `r2-upload.mjs`, `cloudflare-prune.mjs`, `workers/`, `wrangler.toml`). Centraid deploys directly to Cloudflare Pages.
- Renamed the CSS class prefix from `oc-` to `cd-` throughout `assets.mjs` and the MDX-ish component output.
- Replaced brand tokens (primary color, fonts, logo, favicon, header nav links, OG card template).
- Dropped the ClawHub cross-repo content sync.

Both the original and Centraid's adaptation are MIT-licensed.

### Original LICENSE notice

```
MIT License

Copyright (c) 2026 openclaw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
SOFTWARE.
```
