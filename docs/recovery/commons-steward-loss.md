# Commons steward loss

Use this runbook when Sharing reports that a Commons steward is **absent** and offers **Recover from this replica**. The ceremony is intentionally user-driven: a member replica contains the shared domain rows, but it cannot prove that the old steward will never return.

Product paths: `packages/gateway/src/routes/commons-recovery-routes.ts` (status and ceremony), `packages/vault/src/share/commons-recovery.ts` (verified replica export), and the web/native Sharing surfaces (the reachable action).

## Before recovering

1. Confirm this device can reach another peer. A general link outage is shown as `link-down`, not steward loss, and must not be re-founded.
2. Wait for `absent`, not merely `degraded`. The threshold is seven days of steward silence while this device has recent evidence that peer networking works.
3. Do not recover a `parked` grant. `history-diverged` and `digest-mismatch` mean the local replica did not verify; it is not eligible source material.
4. Prefer the member with the freshest verified sequence. Recovery records the source sequence, chain head, checkpoint sequence, state digest, and old→new grant lineage.

## Recover

1. Open Sharing on web or native and choose **Recover from this replica** on the absent Commons.
2. Confirm the warning. The local member becomes steward of a new circle/grant with a fresh genesis chain; the old grant and its receipts remain as superseded history.
3. The gateway immediately enqueues successor invitations in `share_effects` and attempts every former member for whom the new steward already has an approved vault link. Failed deliveries remain parked with bounded exponential retry.
4. Check Sharing until the new Commons is current and the former members have accepted/converged.

## N≥3: a former member is not directly linked

Vault links are pairwise consent; Centraid never creates a transitive link merely because two people shared the old steward. If Alice and Carol were each linked only to old steward Bob, Alice cannot deliver Carol's successor invitation immediately after Alice re-founds the group.

For each undelivered member:

1. Alice starts **Add someone / link a vault** and Carol redeems the ordinary link ticket. This is the normal two-party approval ceremony; do not reuse Bob's old ticket or key.
2. Return to Sharing and run recovery again. Recovery is idempotent for the superseded grant: it reuses the one successor and re-enqueues the missing member invitation rather than creating another group.
3. Carol accepts the new invitation and catches up through the signed checkpoint/tail rail.

This is a known v0 topology limit, not a data repair step. Automatically manufacturing Alice↔Carol authority would silently widen consent and is therefore rejected.

## Split brain and a returning old steward

Supersession is seat-local. Two members can independently re-found, and a returning old steward can still serve a member who never superseded. Do not merge logs or copy rows between successor grants.

1. Choose one successor in person.
2. Link and invite every intended member to that successor using the steps above.
3. On the losing successor/old grant, remove members or revoke the grant from its current steward surface once reachable.
4. Keep both receipt histories. The recovery lineage explains the selected successor; there is no hidden automatic winner.

## Never

- Delete or regenerate a missing vault identity seed. Restore it from the recovery kit; a replacement key is a different authority and fails as `vault_identity_mismatch`.
- Treat repeated transport errors as proof of death; the sweep backoff and device-reach guard exist to avoid that inference.
- Move CAS files by hand. Bootstrap authorizes exact hashes and the local orphan sweep owns eventual unlinking.
