# Issue #928 — one authority plane: retire the app grant evaluator; first-party apps are not principals

Umbrella receipt. One receipt for the whole umbrella; each wave appends its own section.

## Checklist

- [ ] `evaluateAccess` has no `app` identity path; the app bridge issues no app credential; an owner-device read of the owner's vault runs 0 grant statements
- [ ] Replica shapes are composed statically from the app manifest and the sealed registry; shape ids for all eight apps are unchanged on the golden vault; a sealed column name appears in no shape
- [ ] The static tripwire fails a build in which an app query touches an undeclared entity (proven with a seeded violation)
- [ ] `access_grant`, `access_grant_scope`, `access_policy`, `access_scope_tombstone`, `access_scope_request` and every reader of them are gone; `grep -r "dpv:" packages apps` is empty outside receipts and CHANGELOG
- [ ] Every automation's standing answer is a `share_authority` row with `principal_kind = 'automation'`; the owner's prior refusals survive as `declined` rows (count and content asserted by the migration test); a widened manifest still parks
- [ ] The assistant holds no standing grant; its reads and writes are receipted exercises on behalf of the acting owner; scheduler-fired automations are capped by their row
- [ ] `access_receipt` references `authority_id` from one id space; the purpose column is gone; the chain verifier is green; Settings → Access shows last-used for every row
- [ ] Companion attenuation and outbox grants are rows in the one plane; `grant_profile_json` has no reader
- [ ] The give-plane coordinator, edge store, effects, edge routes and retire pass are deleted; moving an album between two of the owner's vaults is one command
- [ ] Locker: sealed set, permits, reveal and `ONLINE_ONLY_ACTIONS` unchanged; its history query filters in SQL; `locker-online-only.test.ts` green
- [ ] Authz deny matrix, automation clamp sweeps and the harness parity integration test green at every slice exit
- [ ] `docs/decisions.md`, SECURITY.md and `docs/vault-ontology.md` state the model above; the drift register rows for the consent plane are closed

Nothing is ticked. Wave 1a writes the rulings only; every criterion above needs code, and the last one needs both halves — the three docs state the model now, but the drift register rows are **open**, not closed, so the item stays unticked until the waves that close them land.

## What changed

Wave 1a is docs-only. It records the rulings #928 makes as current state, so later waves are built over a written answer rather than a guess.

- **`docs/decisions.md`** — new section `## One authority plane (#928)`, placed immediately before `## Related docs`: the four principal kinds with where each is enforced; eight rulings `AP-principals`, `AP-apps-declare`, `AP-owner-direct`, `AP-automation-principal`, `AP-one-id-space`, `AP-attenuations`, `AP-give-residue`, `AP-locker-boundary` stating A1–A7 of the issue as current decisions; the v0 delete-with-replacement stance; the two open questions the root adopted (third-party apps → `app` stays reserved and unwritten; a scheduler-fired automation's principal → one row per automation, not per pack) and the two left open by design (`sqlAsOwner` in wave 3, owner-direct read receipts with #922 B1). Below it, `### The rulings, re-judged (#928)` reproduces the issue's register as a table of Seam | Ruling cited | Property that depends on it now | Verdict — thirteen rows, ten findings, two kept-and-re-homed with the property named, one "holds" row for the spine. No row says "deliberate", and no row is kept without a property.
- **`docs/decisions.md`** — five rows added to `## Superseded decision pointers`: #306 "installing is the consent", #883 V-split's app carve-out, #873 L-access's "the rowFilter is the boundary", #308's tombstones and scope requests (re-homed as `declined` rows for automations), and the assistant's standing `act` grant. Each names #928 and its replacement. The existing `V-split` row in the Grants v2 table gains one appended sentence marking it superseded in part; no other existing text is rewritten.
- **`SECURITY.md`** — the five-layer bullet now says L2 is closed by #928 and carries a second bullet with the four principal kinds and their enforcement points, stating plainly that a first-party app is not a principal and that its reach is fixed at build time by a declared entity manifest plus a static tripwire. The agents bullet's admission that scheduler-fired automations run uncapped is marked **closed by #928 A3** — they act under an explicit `automation` row — with the wave that lands it named. The threat table's `Consent` row is rewritten the same way. L4 attribution keeps its "scheduler-fired automations carry none" admission, now dated — it holds "until their `automation` row lands in #928 wave 3" — because attribution today is unchanged; and "the journal records" becomes "the audit band records", the current name since #916. Every sentence that would claim code not yet landed says instead which wave lands it. No other SECURITY.md sentence changed.
- **`docs/vault-ontology.md`** — six rows added to `## Drift register`, each `open — closes in #928 wave N` with the mechanism named: **ONT-16** the app grant tables, **ONT-17** purposes and the DPV vocabulary, **ONT-18** `access_policy` and its two consultations per non-owner read, **ONT-19** the receipt's four id spaces, **ONT-20** `grant_profile_json` and `outbox_grant`, **ONT-21** the give-plane residue. No row is closed by this slice.
- **`docs/glossary.md`** — `principal` gains `automation` and states the clamp as its locus; new entries define **automation** (principal kind), **app** (reserved principal kind), **authority_id** and **owner-direct read**; the `consent / grant` entry stops calling app grants strategy machinery beneath manifests; two rows in the broader forbidden-synonyms table retire "purpose" / `dpv:` and "app grant" / "consent-scoped app handler", each pointing at #928. Every entry whose sentence would describe code that has not landed names the wave that lands it (the `automation` kind in waves 1 and 3, `authority_id` in wave 4, the app credential in wave 2), and the same wave-naming was added to the #873 supersession row.
- **`receipts/issue-928-one-authority-plane.md`** — this file, created as the umbrella receipt.

## Out of scope

Every code change #928 names: the static tripwire (wave 1b), the vault schema's `automation` principal kind (wave 1c), static shape composition (wave 2), the principal moves and the migration (wave 3), evaluator retirement and the receipt re-key (wave 4), attenuations and the give-plane residue (wave 5). `ARCHITECTURE.md` is untouched — its rewrite lands with the code waves. No test, ledger, budget or allowlist was touched.

## Verification

```sh
bun run format
bun run lint
bun run lint:product
bash .governance/run.sh
bun run check:push
```

## Decisions

- **The drift register rows are opened, not closed.** The contract for this slice and the register's own convention agree: a finding whose mechanism has not landed is deferred and says so. The acceptance criterion that names them therefore stays unticked even though the three docs now state the model.
- **`docs/vault-ontology.md`'s "Was the starting design right?" §2 still says the `access` plane survives as "the machinery beneath manifests, and nothing else".** That sentence is contradicted by AP-owner-direct but describes a mechanism that is still in the code today; rewriting it now would claim a deletion that has not happened. It is re-stated in the wave that deletes the machinery (wave 4), and ONT-16 is the register row that keeps it from being forgotten.
- **The `consent / grant` glossary entry was adjusted beyond the four terms the contract named.** It asserted the exact carve-out #928 supersedes ("App and device scope grants are strategy machinery beneath manifests"), so leaving it would have left a defined term contradicting the ruling on the same page.
- **SECURITY.md's "Cannot: protect against a malicious app the owner installed with broad grants" is left alone.** It sits in the transport section, is still true of the code as it stands, and rewriting it belongs to the wave that removes the grants it names.

## Audit

_Pending: the root runs a fresh-context verifier against this worktree and writes the verdict here before the branch is pushed._

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
