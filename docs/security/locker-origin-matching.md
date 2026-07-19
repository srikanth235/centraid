# Locker origin matching v1

This document is the normative origin-matching contract for Centraid Companion. Its executable conformance vectors live at `apps/extension/spec/origin-matching-v1.json`.

## Security boundary

Matching only decides whether a secret-free suggestion may be shown. A match never reveals a credential. Reveal and fill require a separate, explicit user gesture and produce a vault receipt whose context names the page origin. Cross-origin frames are never eligible.

Both the saved URL and the page URL must be absolute `http:` or `https:` URLs. Public hosts require HTTPS. HTTP is accepted only for `localhost`, loopback IPv4, and loopback IPv6 development origins. Invalid URLs fail closed.

## Canonical comparison

URL parsing supplies lowercase, IDNA-normalized host names and normalized default ports. The comparison requires the same scheme and uses only its effective port and host identity. Paths, queries, fragments, credentials, and user-supplied labels never participate.

The default `registrable-domain` policy compares Public Suffix List eTLD+1 values. IP addresses, localhost, and hosts for which no registrable domain exists are compared as exact hosts. The optional per-item `exact-host` policy always compares the normalized host exactly. In both policies the effective port must match.

There is no substring, suffix, edit-distance, or “closest credential” fallback. A page with no exact policy match gets no suggestion.

## Fill lifecycle

The content script reports only the top-frame origin and detected field kinds. The extension worker requests secret-free candidates, applies this contract locally, and returns display labels. Clicking a candidate causes one context-bound reveal of the password and, when available, one derived TOTP result. The seed never leaves the vault. The worker returns fill material directly to the requesting content script and does not cache it.
