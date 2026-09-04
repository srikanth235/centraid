# Issue #929 — sharing as subscription

Umbrella receipt for [#929](https://github.com/srikanth235/centraid/issues/929). Slices append one `## <wave><slice> — <title>` section each; nothing above a new section is rewritten. Created by the S6 slice, which is the first of this umbrella to land code — the earlier waves' sections are appended by their own lanes.

## Checklist

- [x] The share sheet offers the link ticket inline for an unlinked person; #903's refusal is unchanged
- [ ] `DocsSharedView` and the Photos/Tally shared surfaces read the shape lineage instead of the commons/closure markers

## What changed

**The share sheet offers the link ticket inline for an unlinked person; #903's refusal is unchanged.** Before this, a member who opened Share on somebody this vault has never reached read one sentence — "Link their account in People to share with them." — and had no way to act on it: leave the sheet, find the link row in Settings or People, mint a ticket, come back. The finding was never the refusal. [#903](https://github.com/srikanth235/centraid/issues/903)'s rule that a grant needs a live binding is right and is untouched here: `reachBlocksSharing` still disables the submit, `cannotShare` is unchanged, and the sheet still grants nothing. What is added beside the refusal is the one act that would lift it, through the ceremony that already exists.

| Path | Change |
| --- | --- |
| `packages/blueprints/apps/_shared/grant-plane.ts`, `packages/blueprints/apps/_shared/grant-plane.test.ts` | `offersLinkTicket` (party + blocked reach only — a circle has no person to link, `unknown` is not a refusal), `LinkTicketDoor`, `MintedLinkTicket`, `parseMintedLinkTicket`: the wire guard both seats share |
| `packages/blueprints/apps/_shared/grant-copy.ts`, `packages/blueprints/apps/_shared/grant-copy.test.ts` | The five sentences, and `linkTicketExpiry` — read off the ticket, never a remembered TTL |
| `packages/blueprints/apps/_shared/link-ticket-panel.ts` | `useLinkTicket`: no ticket until asked for, one on request, the door's refusal in its own words; cleared when the sheet closes |
| `packages/blueprints/apps/_shared/GrantSheetTicket.tsx` (new), `packages/blueprints/apps/_shared/GrantSheet.tsx`, `packages/blueprints/apps/_shared/GrantSheet.module.css`, `packages/blueprints/apps/_shared/GrantSheet.claims.test.tsx` | The offer under the reach line, web seat — its own component for the reason the phone's is, and because the sheet is at `repo-hygiene`'s 625-line ceiling |
| `packages/blueprints/apps/_shared/grant-gateway.ts` | `webLinkTicketDoor`, feature-detected like every other optional bridge method |
| `packages/blueprints/types/centraid.d.ts`, `packages/client/src/react/blueprints/centraid-inline.ts` | `linkTicket()` on the host bridge — the SHELL's own vault mints, so a blueprint app cannot choose which vault it links. It calls `mintGatewayLinkTicket`, the existing `POST …/links/ticket` over `peer_link_tickets`; **nothing new on the gateway** |
| `apps/mobile/src/kit/share/GrantSheetTicket.tsx` (new), `apps/mobile/src/kit/share/GrantSheet.tsx`, `apps/mobile/src/kit/share/GrantSheet.styles.ts`, `apps/mobile/src/kit/share/grant-seat.ts` | The same offer on the phone, over `mintLinkTicket` — the call `SharingLinkRow` already makes |
| `apps/mobile/src/kit/share/GrantSheet.test.tsx`, `apps/mobile/src/kit/share/GrantSheet.flows.test.tsx`, `apps/mobile/src/apps/people/PersonGrants.test.tsx` | The phone claims, plus the `expo-clipboard` and `grant-seat` seams the sheet now reaches |
| `apps/web/tests/e2e/grant-sheet.spec.ts` | A second case in a real browser: the ticket is offered, minting shows it, and `Share` stays disabled |
| `tests/agent-e2e-mobile/flows/sharing-reach.mjs` | Its private copy of the frame publisher deleted for `tests/agent-e2e-mobile/lib/ui-impact.mjs`, the one owner (#922 H1) |

## Out of scope

- Any gateway or share-engine file. The ticket ceremony, `peer_link_tickets` and the `…/links/ticket` route are unchanged; this slice only reaches them.
- #903's refusal rule and `reachBlocksSharing` itself — unchanged, because the property they keep is that no grant exists without a live binding to carry it; the tests above pin that the offer does not soften it.
- Redeeming a ticket from the sheet. The far side pastes it in People or Settings, where the redeem surface already lives; a second redeem control would be a second place to keep correct.
- The shape-lineage surfaces (`DocsSharedView`, Photos, Tally) — the second checklist box, whose engine lane has not landed.
- `## Audit` — added by the wave's fresh-context verifier, never by the author.
- **Other umbrellas' files on this integration branch.** `receipt-per-issue`'s file-coverage rule reads paths from the receipts *added* in a change set, and on `claude/surfaces-device-rung` this is the only added one — so the mega-lane's #922 slice is listed here to satisfy it, and is **described and owned by `receipts/issue-922-snappier-blueprints.md`**, never by this receipt: `apps/mobile/App.tsx`, `apps/mobile/lazy-navigators.tsx`, `apps/mobile/lazy-screens.tsx`, `apps/mobile/src/apps/docs/DriveList.tsx`, `apps/mobile/src/apps/locker/LockerItemsView.tsx`, `apps/mobile/src/apps/locker/LockerItemsView.test.tsx`, `apps/mobile/src/apps/notes/NotesPlaces.tsx`, `apps/mobile/src/apps/people/PeopleHome.tsx`, `apps/mobile/src/apps/tally/ActivityView.tsx`, `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`, `apps/mobile/src/kit/components/SeatList.tsx`, `apps/mobile/src/kit/components/SeatList.test.tsx`, `apps/mobile/src/kit/components/list-anchoring.ts`, `apps/mobile/src/kit/replica/ReplicaProvider.tsx`, `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx`, `apps/mobile/src/kit/replica/replica-mount.ts`, `apps/mobile/src/kit/replica/replica-mount.test.ts`, `apps/mobile/src/test/react-native-stub.tsx`, `tests/agent-e2e-mobile/flows/docs-drive.mjs`, `tests/agent-e2e-mobile/flows/pairing-canary.mjs`, `tests/agent-e2e-mobile/flows/people-roster.mjs`, `tests/agent-e2e-mobile/lib/ui-impact.mjs`, `tests/scale/photos-memories.scale.test.ts`; and the #927 slice, **described and owned by `receipts/issue-927-perf-infra.md`**: `.github/workflows/e2e.yml`, `.github/workflows/soak-weekly.yml`, `docs/decisions.md`, `packages/test-kit/package.json`, `packages/test-kit/tsconfig.build.json`, `packages/test-kit/src/vitest.ts`, `scripts/accessibility-contract.test.mjs`, `scripts/ci/device-farm-lease.sh`, `tests/agent-e2e-mobile/roster.json`, `tests/agent-e2e-mobile/flows/device-rung-budget.md`, `tests/budgets.json`, `tests/claims.json`, `tests/journeys.json`, `tests/quality/classification-ratchet.json`, `tests/quarantine.json`.

## User impact

The Share sheet, opened on somebody this vault has never reached, now offers **Send them a link ticket** directly under the reach line. Pressing it mints one one-time ticket, shows it with a Copy control and its own expiry, and says what to do with it. Nothing is sent on the member's behalf, and nothing is granted: `Share` stays disabled until the link is live, which is #903's rule unchanged.

First-run: unchanged. A first-run vault has no people to share with at all, so the sheet draws its "nobody to share with" state exactly as before; the offer appears only once a person exists whom this vault cannot reach.

![The share sheet offering a link ticket for an unlinked person, with Share still refused](artifacts/e2e/ui-impact/issue-929-grant-sheet-link-ticket.png)

Emitted by the changed harness `apps/web/tests/e2e/grant-sheet.spec.ts`, run in this container against the shipped sheet over the shipped tokens. The phone seat has no frame: no mobile journey reaches the grant sheet for an unlinked person today, and this container has no simulator or device — see Decisions.

## Decisions

- **The phone frame is owed and not produced here.** `sharing-reach.mjs` reaches the *share* sheet for a Tally group, never the *grant* sheet for an unreached person, and no other flow opens it. Writing the navigation blind, into a flow this container cannot run, would be a worse artifact than saying so. What a maintainer or a device lane must run to close it: a mobile journey that opens People → a person with no live link → Share, asserts `Send them a link ticket`, presses it, asserts the ticket and that Share is refused, and publishes the frame through `tests/agent-e2e-mobile/lib/ui-impact.mjs`. The phone's own claims are pinned in `apps/mobile/src/kit/share/GrantSheet.test.tsx` in the meantime.
- **The shell's vault mints, not the caller's.** `linkTicket()` takes no argument. A blueprint app that could name the vault could link a vault it was never given.
- **The expiry is the ticket's.** `linkTicketExpiry` counts from `expiresAt`; the "15 minutes" in the transport's comment is the gateway's to change, and a sentence that remembers it becomes a lie the day it does.

## Verification

```sh
bun run --cwd packages/blueprints test                                # 211 files, 6644 passed
bun run --cwd packages/client test -- src/react/blueprints            # 9 files, 81 passed
bun run --cwd apps/mobile test -- src/kit/share src/apps/people       # 11 files, 105 passed
bun run --cwd packages/blueprints typecheck && bun run --cwd packages/client typecheck
bun run --cwd apps/mobile typecheck
# self-audit PASS on tree de198294689e61dc8c2bdee7f6b777098a08c207 (head 46d93d572,
# base 276273831 — the branch's previous head, this slice alone). Governance:
# 20/22, the two reds being `receipt-per-issue` on the `## Audit` the wave
# verifier writes. The hash line is the only edit after that run.
CENTRAID_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell \
  npx playwright test -c tests/e2e/playwright.config.ts grant-sheet.spec.ts   # 2 passed
```

### Falsification

| Claim | Throwaway check | Result |
| --- | --- | --- |
| The offer does not soften #903 | Asserted `Share` is disabled in the same browser frame that shows the minted ticket, and again after minting on both seats | GREEN — `toBeDisabled()` holds after the mint; `window.__grantStatus` stays `[]` |
| The ceremony is only offered where it applies | `offersLinkTicket` over the four reaches and both audience kinds | RED for `live`, `unknown`, `circle`, and an absent audience — only `party` + `never-reached`/`severed` are offered |
