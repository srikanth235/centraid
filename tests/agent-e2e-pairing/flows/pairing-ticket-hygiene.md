# pairing-ticket-hygiene

The failure half of the ceremony: every way a ticket must NOT admit a device.

## Goal

Prove the security properties the pasteable token relies on, against the real
daemon + CLI + iroh transport (not the in-process store tests):

- a wrong secret burns the ticket — the right secret is useless afterwards,
  and the prober never becomes enrolled;
- an expired ticket never redeems, even with the correct secret;
- an unenrolled device is refused at the QUIC layer regardless of what HTTP
  path it asks for.

## Setup

Fresh `--data-dir`, default vault only.

## Steps

1. Mint ticket A. Redeem with a WRONG secret → refused. Redeem again with the
   RIGHT secret → still refused (burn-on-first-attempt). `devices list` stays
   empty; the device cannot tunnel.
2. Mint ticket B with `--ttl-minutes 0.001`, wait past expiry, redeem with the
   correct secret → refused. Still not enrolled.
3. Garbage pasted into the ticket parser → rejected client-side (no dial).

## Verdict

PASS iff every redemption above is refused and the device never gains tunnel
admission.
