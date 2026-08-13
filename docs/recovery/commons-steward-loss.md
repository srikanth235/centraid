# Recovery: a Commons steward is gone

When the single steward vault of a shared space (Commons plane, issue #731/#750) stops answering — lost device, wiped machine, person unreachable — and the group needs to keep going. Product paths: `packages/vault/src/share/commons-recovery.ts` (the ceremony), `packages/gateway/src/routes/commons-recovery-routes.ts` (the doors), `packages/gateway/src/serve/commons-recovery-invites.ts` (delivery), `packages/gateway/src/serve/commons-notices.ts` (the card that starts this).

## Invariants (do not violate while recovering)

| Rule | Detail |
| --- | --- |
| Absence is **evidence**, not a guess | Escalation reads `share_commons_steward_contact` (per grant) against `share_commons_device_reach` (this device). A silent steward while this device reached nothing at all is `link-down`, never `absent` |
| A **parked** seat may not re-found | A named divergence fault (`history-diverged`, `digest-mismatch`) means the replica is state this seat could not verify. The ceremony refuses with `parked-on-fault`. Answer the fault first |
| The old grant is **superseded, not deleted** | Its ops, receipts and projected rows stay exactly where they are on every seat; only its sync stops (`revoked_at` is set) |
| The successor starts a **fresh genesis chain** | The old chain's authority was the missing steward's key. The successor is sequence 0 over the same closure bytes |
| Consent is **never fabricated** | Every other seat — including the lost steward's party — is INVITED and must accept. The successor's roster mirrors the old one; it does not assume it |
| One successor per superseded grant | `share_commons_supersession` is the idempotency key. Re-running the ceremony returns the same successor (`replayed: true`) |

## 1. Detect

The member seat raises a `commons-steward` notice (severity `high`) once its own recorded evidence escalates to `absent` — silent past seven days while this device demonstrably completed peer round trips — or to `parked`. The card carries `detail.recoverable`: `true` for a real absence, `false` for a parked seat (which must be answered, not re-founded). The commons sweep raises it; nothing polls a network to decide.

Read the same evidence directly at any time:

```
GET /centraid/_gateway/commons/recovery?actorVaultId=<vaultId>
```

Per grant it reports `steward.presence` (`unknown | reachable | degraded | absent | link-down | parked`), `silentForMs`, consecutive failures, the pull-outcome histogram, absence episodes, and op-log/member-lag counters.

Before running the ceremony, confirm with a human that the steward is genuinely gone. `absent` means "silent for a week with a working local link" — it is a strong signal, not a death certificate. A steward that comes back after a successful re-founding lands in the split-brain case below.

## 2. Run the ceremony

Any member seat holding a complete replica can re-found the group:

```
POST /centraid/_gateway/commons/recovery
{ "actorVaultId": "<recovering member vault>", "grantId": "<abandoned grant>", "reason": "steward absent since …" }
```

`200` returns `state: "recovered"` with the successor `grantId`, the lineage (`sourceSequence`, `sourceChainHeadHash`, `sourceVerifiedSequence`, `sourceStateDigest`), `invitedPartyIds`, `replayed`, and — the part an operator must read — `invitations`.

`409` returns a NAMED refusal: `already-steward`, `parked-on-fault`, `grant-not-live`, `no-local-replica`.

## 3. Deliver the invitations

The ceremony now delivers them; it no longer leaves that to "the caller" (which was nobody). Each invited seat gets one of four outcomes, reported per party in `invitations`:

| `state` | What happened | What the operator does |
| --- | --- | --- |
| `queued` | The member vault is mounted on this same gateway; the invitation is already on its seat | Nothing — the member answers it in their own app |
| `delivered` | An approved vault link between the NEW steward and the member existed; the invitation was pushed over the peer plane | Nothing |
| `unreachable` | A member vault is known, but the peer push failed right now (no dial, link down, peer refused) | Retry the ceremony later, or carry the claim token that was minted as a fallback |
| `claim` | No vault is bound to that party at this seat at all | Carry the one-time claim token out of band (see below) |

For `N = 2` the linked case always holds: the two members are linked to each other, so the successor can reach its one peer directly.

### The `N ≥ 3` case (the honest limit)

Vault links are pairwise. In a group founded by one steward, member↔member links may not exist: A, B and C each linked to the steward, not to one another. When B re-founds the group, C has **no link to B**, so nothing on the network can deliver the invitation, and the vault that could have introduced them is precisely the one that disappeared.

What we do instead of pretending otherwise: the successor mints a one-time **claim ticket** bound to C's party (`share_commons_invitation.claim_token_hash`; only the hash is durable). The ticket is old-steward-independent by construction — nothing in the claim path touches the lost vault. Delivery of the ticket is a human act:

1. B copies the claim token from the ceremony response (it is returned once; never log or store it).
2. B sends it to C over any channel they already trust, with the ordinary invite wording (`commonsInviteMessage`).
3. C pairs with B's gateway if they are not already linked (ordinary pairing — see [pairing.md](pairing.md)).
4. C redeems the ticket (People & circles → paste the invitation), reviews the size, and accepts or refuses.

This is a genuine limit, not a bug we forgot: without a pre-existing link and without the old steward, there is no cryptographic path from B to C that C should trust automatically. Anything automatic here would be inventing a trust edge on C's behalf.

## 4. Members converge

An accepting member is admitted to the successor (`upsertCommonsMember`) and the successor compiles into their seat: they now project the successor grant, with B as steward, over the same closure bytes. The superseded grant remains on every seat as history. Verify:

- the member lists both grants, and only the successor is live (`revoked_at IS NULL`);
- `share_commons_supersession` on the recovering seat explains where the successor came from;
- the member's absence notice can be archived once the successor is syncing (the notice is not re-raised for a superseded grant).

## 5. Split-brain re-founding (know this before you start)

Supersession is **seat-local**. Nothing in the protocol elects a single successor:

- if B and C both run the ceremony, each mints its own successor over its own replica, and each invites the other. There is no merge — two live groups exist, and members choose which to accept (accepting both is possible and means two independent spaces with the same contents at the fork point);
- if the old steward comes back, its grant is still live _on its own seat_ — it never learned it was superseded. It will keep serving pulls to any seat that still asks. Those seats stopped asking only because they set `revoked_at` locally during their own ceremony;
- a member that never accepts the successor keeps a frozen replica of the old grant forever, which is the intended failure mode (data is never destroyed) but is easy to mistake for "sync is broken".

Operator rule of thumb: **one ceremony, agreed out of band, then everyone accepts the same successor.** If two successors already exist, pick one, have every member accept it, and treat the other as an abandoned copy — do not try to merge chains.

## Symptoms → first move

| Symptom | First move |
| --- | --- |
| `commons-steward` notice, `presence: absent` | Confirm with a human, then step 2 |
| `commons-steward` notice, `presence: parked` | Do NOT re-found. Read `fault` on the contact row; a diverged history needs the steward's answer or a fresh bootstrap |
| Ceremony returns `no-local-replica` | This seat never projected the container (invited but never accepted). Re-found from a seat that did |
| Ceremony returns `already-steward` | This vault owns the grant; there is nothing absent about it |
| `invitations` shows `claim` / `unreachable` for someone | Carry the token by hand (step 3); nothing else will reach them |
| A member accepted but still sees the old contents | They accepted the successor but have not compiled yet; the steward's next compile/sweep tick projects it |

## Related

- [pairing.md](pairing.md) — establishing the vault link a claim redemption needs.
- [backup-restore.md](backup-restore.md) — when the steward's device is recoverable, restore is better than re-founding.
- [../protocol.md](../protocol.md) — the commons stream/cursor contract, one intent grammar, and declared routing.
