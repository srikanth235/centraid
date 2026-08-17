# Issue #807 — generic enrichment system (capability / engine / policy / consent) + Settings consolidation

GitHub issue: [#807](https://github.com/srikanth235/centraid/issues/807)

Umbrella receipt. Waves land as PR waves under this one issue; each wave appends
to the sections below rather than opening a receipt of its own. Landing order:
Wave 0 → 1 → 2 (with a main merge) → 3+6 together → 4, 5 → docs and audit.

## Checklist

- [x] Wave 0 — schema and contracts
- [x] Wave 1 — engine profiles
- [x] Wave 2 — policy cascade and gate resolver
- [x] Wave 3 — egress-consent re-keying
- [x] Wave 6 — mobile read-only effective-policy projection

## What changed

**Wave 0 — schema and contracts.** `enrich_derivation` gained a `profile` dimension (default
`built-in`) and its uniqueness widened to
`(target_type, target_id, variant, profile)`, so several engine profiles' results
for one variant coexist; `preferredDerivation` is the single resolution helper
every consumer reads through (issue Q5), and `stampedModel` resolves through it.
Two new vault tables land ahead of the waves that consume them:
`enrich_policy_rule` (the scoped cascade's rule store — vault | domain |
collection | item, per capability, `NULL` meaning inherit) and `enrich_consent`
(capability × egress class × optional scope, with a journal receipt pointer).
Both are registered in `schema/tables.ts`, so the canonical export walk and the
replica change log carry them. `packages/server/src/enrich/capability-registry.ts`
formalizes the nine shipped capabilities as versioned contracts.
The backfill story is unchanged by the keying: the backfill selector
(`idx_enrich_derivation_model`, capability + model) is profile-agnostic, so a
model/version bump re-arms exactly the rows behind it within each profile —
re-enrichment stays backfill, never destructive. `schema/poly-refs.ts` records
`enrich_policy_rule` in `POLY_REF_EXCLUSIONS`: its (scope_type, scope_ref) is a
cascade level, not the polymorphic entity shape, so rules are not swept on
purge — a rule whose collection is gone matches nothing and is inert.

**Wave 1 — engine profiles.** `packages/server/src/enrich/engine-profiles.ts`
is the profile model over the existing prefs/harness machinery: one immutable
built-in profile per capability (id `built-in`, derived from the capability
registry — the exact value `stampDerivation` has always written), and member
profiles stored one per prefs key `enrich.profile.<id>` (JSON: capability,
label, harness, model, configPins, promptRev). Egress class is computed, never
stored: built-in profiles read their enricher lane (`device` → `on-device`,
`gateway` → `gateway`; the gateway is the member's own infrastructure, not
egress), delegate profiles are `provider` via a `delegateEgress` seam that a
future local-inference harness would answer. Faces is structurally excluded
from delegate profiles (`capabilityAllowsDelegate`). Writes ride the existing
`PUT /_centraid-user/prefs` path: `validateEngineProfilePatch` is wired into
the gateway's `validatePatch` hook in
`packages/server/src/serve/build-gateway.ts` (refusal → 409, mirroring
harness-pin preflight). Read surface: `GET /centraid/_enrich/profiles`
(`packages/server/src/routes/enrich-profiles-routes.ts`, registered
device-auth/no-vault in `packages/server/src/routes/route-security.ts`).
`docs/config-ownership.md` documents the new `enrich.profile.*` prefs surface
and its single writer.

**Wave 2 — policy cascade and gate resolver.** The scoped cascade resolves
inside the one gate: `packages/server/src/automation/fire/enrich-resolve.ts`
(re-exported only through `enrich-gate.ts`) folds a least-specific-first rule
chain over the legacy tier — `resolveEnrichmentPolicy(rules, legacyTier,
capability)` — with most-specific-wins per field and the legacy tier preserved
as an egress-class CEILING (`off → off`, `device → on-device`, `gateway →
gateway`); only the vault-default layer can set the ceiling, so no rule and no
per-item selection can widen egress. `decideEnrichmentGate` gains the
profile-aware form (refuses when the selected profile's egress exceeds the
ceiling; `profileEgress: undefined` is a refusal) while the legacy tier form
and the C5 rank law stay byte-compatible; allowed decisions now carry
`egressConsentNeeded` — the Wave 3 consent seam. The fire seam
(`packages/server/src/automation/fire/fire.ts`,
`packages/server/src/automation/index.ts`) grows to a request object
`{domain, capability, lane, scopeChain}` that still accepts a bare tier, and
`packages/server/src/serve/build-gateway.ts` answers it with `{tier, rules,
egressForProfile}` via `packages/vault/src/enrich/policy.ts`'s new
`readEnrichPolicyResolutionInput` (consent-bridge-free, same rationale as
`readEnrichPolicyTier`; exported through `packages/vault/src/index.ts`, tests
in `packages/vault/src/enrich/enrich.test.ts`). HTTP: `GET /_vault/enrich`
additively gains `rules`; new `PUT/DELETE /_vault/enrich/rules` and
`GET /_vault/enrich/effective` live in
`packages/server/src/routes/vault-enrich-rules-routes.ts` (+ test), mounted
from `packages/server/src/routes/vault-routes.ts`. Client:
`getEnrichRules`/`setEnrichRule`/`deleteEnrichRule`/`getEffectiveEnrichPolicy`
in `packages/client/src/gateway-client-vault.ts` with vocabulary mirrors in
`packages/client/src/enrich-policy.ts`, seam fixtures in
`packages/client/src/gateway-client-seam-fixtures.ts`, and additive contract
laws in `packages/client/src/gateway-client-enrich.contract.test.ts`.
`docs/blueprint-seats.md` § Enrichment doctrine gained the cascade paragraph.
Resolver tests: `packages/server/src/automation/fire/enrich-resolve.test.ts`,
gate tests extended in `packages/server/src/automation/fire/enrich-gate.test.ts`.

**Wave 3 — egress-consent re-keying.** The gate's allowed decisions carry the
consent question and the fire path now answers it independently of the
cascade: `EnrichGateInput.egressConsent` (an `EnrichEgressConsentLookup`)
consults the vault's `enrich_consent` ledger via the read-only
`packages/server/src/enrich/egress-consent-lookup.ts`
(`readEnrichConsentForChain`: most-specific-first scope walk, nearest answer
wins), wired through `EnrichPolicyResolution.egressConsent` in
`enrich-resolve.ts`/`fire.ts`/`build-gateway.ts`. Back-compat is load-bearing
and tested: for `on-device`/`gateway` egress the TIER is the recorded answer
(no lookup, no new refusals for existing vaults); only `provider` egress
requires a granted row — missing is a refusal ("an absent answer is not a
grant"), declined stands until re-answered, both with capability-scoped
ledger-visible reasons. Writers: new journalled command
`enrich.record_consent` (`packages/vault/src/commands/enrich.ts`, risk high,
confirm-gated so apps park rather than answer for the member); Photos' manual
capability ask in `enrich.request_enrichment` re-keys as `(capability,
on-device, granted)`; Scan's answer posts best-effort to the new owner-plane
route from `apps/mobile/src/screens/Scan.tsx` (the device latch stays the
gate). HTTP: `GET/POST /centraid/_vault/enrich/consent` in
`vault-enrich-rules-routes.ts` (+ test). Client:
`listEnrichEgressConsent`/`recordEnrichEgressConsent` in
`gateway-client-vault-enrich.ts`. Privacy audit: "Enrichment egress answers"
section on `packages/client/src/react/screens/ApprovalsScreen.tsx` via
`buildEnrichConsentRow`/`enrichCapabilityLabel` in
`packages/client/src/react/shell/routes/approvalsData.ts`, fetched in
`packages/client/src/react/shell/routes/ApprovalsRoute.tsx`; reuses existing
ledger blocks, no new CSS. `docs/photos/derived-ledger.md` records the
one-writer rule and the "tier is the recorded answer" doctrine.

**Wave 6 — mobile read-only effective-policy projection.** New
`apps/mobile/src/screens/settings/EnrichmentSection.tsx` (+ `.test.tsx`, six
tests incl. a "renders no control" law) rendered from
`apps/mobile/src/screens/Settings.tsx` between Vault and Band; wire client
`apps/mobile/src/lib/enrichment.ts` reads `GET /centraid/_enrich/profiles`
plus `GET /centraid/_vault/enrich/effective` per capability (the one
resolver answers; the phone folds nothing). Member-facing capability labels
and egress words ("on this device" / "on your gateway" / "sent to a
provider"); `effective: null` reported as the fail-closed state; offline
renders an honest unavailable state with no cached fabrication
(docs/mobile-offline.md). Read-only — no toggles, no writes.

## Decisions

#807 Wave 0 registers two new enrichment tables (enrich.policy_rule, enrich.consent) in schema/tables.ts, and the Atlas census counts one row-count query per REGISTERED table: the measured SQL baseline rises 138 -> 140, with no additional HTTP request and no new query per table beyond that count. Registration is what carries both tables through portable export and the replica change log, so the two statements are the price of them being real vault rows rather than a side store. Prior: #731 Atlas now counts the registered Commons control tables during its bounded first-paint census; the measured SQL baseline rises from 128 to 138 with no additional HTTP request.

#807 Wave 0: enrich_derivation gains a `profile` column and widens its UNIQUE key to (target_type, target_id, variant, profile) so plural engine results coexist; enrich_policy_rule (scoped policy cascade) and enrich_consent (capability x egress class) are new tables, both registered in schema/tables.ts so the canonical walk carries them. Export completeness re-audited in packages/vault/src/gateway/portable-export.ts: the new tables are owner decisions that must survive restore (a dropped consent row re-asks an answered question, or loses a recorded refusal), and the widened stamp key rides an already-walked table. No adapter, no content bytes, no table dropped.

**Rule fields are nullable.** `enrich_policy_rule.enabled`, `.profile` and
`.trigger_on` are each nullable and mean INHERIT, with a CHECK refusing a row
that decides nothing. The issue lists the three as a rule's contents; making
them mandatory would have forced every scope to restate decisions it does not
own, which is the opposite of a cascade.

**No resolver in Wave 0.** `enrich/policy-rules.ts` and
`enrich/egress-consent.ts` are storage only — no `mayThisRun`. Wave 2 grows
`decideEnrichmentGate` into the resolver; a storage-level answer would be the
second policy path the umbrella forbids.

**Schema evolution.** No migration rung and no table rebuild: `schema/enrich.ts`
is the pre-release, single-rung, edit-in-place base (`schema/migrate.ts`), where
a file written by an older shape is re-created rather than migrated. The
`profile` DEFAULT is what keeps every existing stamp call site byte-identical.

#807 Wave 1 registers the read-only /centraid/_enrich prefix in route-security.ts (device auth, none vault scope) for the engine-profiles listing; the classified owner file changes only by that registration row, no existing route's auth class changes, and no quality grade, budget, or demonstrated-red claim weakens. Prior: #801 (chain preserved in receipts/issue-801-package-consolidation.md and git history of this file).

**Wave 1 deviations.** (1) Engine variants are `built-in`/`delegate` (repo
vocabulary), not `builtin`/`provider`. (2) Built-in profile identity is
`(capability, "built-in")` rather than per-capability minted ids, matching the
ledger's `BUILT_IN_PROFILE`; `readEngineProfile` takes an optional capability
to resolve it. (3) Enricher lane is injected via `laneFor`, defaulting to
`gateway` (the same fail-safe `manifest.ts` applies) — no filesystem reads on
a pure config path. (4) The profiles route reports no harness availability
(no probes); Settings pairs it with `/_harnesses/status`. (5) Reader lenient /
writer strict on malformed optional fields. (6) New route module instead of
growing harnesses-routes. (7) `delegateEgress(harness)` ignores its argument
today — the seam is the point, not a knob.

**Wave 2 deviations.** (1) Resolver is a sibling module `enrich-resolve.ts`
re-exported through the gate (file-size limit; one doorway preserved). (2) A
delegate profile is refused this wave — `provider` is unreachable as a ceiling
until the Wave 3 consent ledger; no regression since no prior path could
select one. (3) Unreadable tier WITH rules present resolves at the most
conservative base (disabled, `on-device` ceiling); unreadable tier with no
rules stays an outright refusal. (4) The consent seam is on the decision
OUTPUT (`egressConsentNeeded`) rather than an input callback. (5)
`sealModelTurns` derives from `egressCeiling !== "gateway"`, provably the old
`tier !== "gateway"`.

**Wave 3 deviations.** (1) `enrich_consent.receipt_id` stays NULL on
command-written rows — a command's receipt id is minted after its transaction
commits, and a post-commit stamp would be a second writer; the durable receipt
is the invocation's own journal receipt. (2) Provider egress became reachable
(granted row over a `gateway` ceiling) — without it the consent check would be
dead code; the Wave-2 ceiling-refusal test was retargeted to `device`
lane/tier, no refusal removed. (3) Photos' decline writes nothing, matching
its shipped "nothing was run and nothing was written" copy; Scan's decline is
recorded. (4) Mobile Wave-6 section fetches through a `lib/` wire module with
one optional `read` test-seam prop, diverging from prop-less sibling sections.

## Out of scope

Waves 1–6 (engine profiles, policy cascade + gate resolver, consent re-keying,
Settings consolidation, delegate expansions, mobile projection) land as later
waves under this same receipt. Provider-cost ceilings (issue Q7), a `tally`
domain (Q1), functional blueprint settings (Q2), and delegate engines for faces
(Q3) are out of scope per the issue's rulings. The legacy `EnrichTier` mirror
stays authoritative until the Wave 2 resolver absorbs it.

## Verification

```sh
bun run --cwd packages/vault test           # 173 files, 1310 passed, 2 skipped
bunx turbo run typecheck --filter=@centraid/vault --filter=@centraid/server  # 19/19
bun run --cwd packages/server test -- capability-registry  # 6 passed
bun run lint                                # clean
bun run lint:schema-export                  # ratchet green
bun run test:qualities                      # 24 passed
bun run format:check                        # clean
```

Wave 1:

```sh
bun run --cwd packages/server test -- engine-profiles        # 28 passed
bun run --cwd packages/server test -- enrich-profiles-routes # 3 passed
bun run --cwd packages/server test -- build-gateway.test     # 24 passed
bunx turbo run typecheck --filter=@centraid/server           # 19/19
bun run lint && bun run format:check && bun run lint:protocol-routes  # clean
```

Wave 2:

```sh
env -u IS_SANDBOX bun run --cwd packages/server test -- enrich-gate      # 23 passed
env -u IS_SANDBOX bun run --cwd packages/server test -- enrich-resolve   # 11 passed
env -u IS_SANDBOX bun run --cwd packages/server test -- vault-routes     # 24 passed
env -u IS_SANDBOX bun run --cwd packages/server test -- vault-enrich-rules # 10 passed
env -u IS_SANDBOX bun run --cwd packages/vault test                      # 1312 passed, 2 skipped
env -u IS_SANDBOX bun run --cwd packages/client test -- gateway-client-enrich # 9 passed
bunx turbo run typecheck --filter=@centraid/server --filter=@centraid/vault --filter=@centraid/client # 19/19
```

Waves 3 and 6:

```sh
env -u IS_SANDBOX bun run --cwd packages/server test -- enrich       # 14 files, 190 passed
env -u IS_SANDBOX bun run --cwd packages/vault test                  # 1316 passed, 2 skipped
env -u IS_SANDBOX bun run --cwd packages/client test -- Approvals    # 74 passed
env -u IS_SANDBOX bun run --cwd packages/blueprints test -- consent  # 20 passed
env -u IS_SANDBOX bun run --cwd apps/mobile test -- EnrichmentSection # 6 passed
env -u IS_SANDBOX bun run --cwd apps/mobile test -- Scan             # 12 passed
bun run --cwd apps/mobile typecheck && bun run --cwd apps/mobile lint # clean
bun run lint:mobile-design                                            # clean
bunx turbo run typecheck --filter=@centraid/server --filter=@centraid/vault --filter=@centraid/client --filter=@centraid/blueprints # 19/19
```

## Audit

Fresh-context adversarial sub-agent, handed the diff, this receipt, and issue
#807's Wave 0 scope; instructed to default to REFUTED.

1. `## What changed` faithfully describes the diff — **PASS** (re-verified the
   widened UNIQUE key, `preferredDerivation` fallback order, both new tables'
   DDL, `schema/tables.ts` registration, and that no UI files changed).
2. Each `- [x]` item is realized in the diff — **PASS** (re-ran vault
   derivation/policy-rules/egress-consent tests, 26 passed, and
   capability-registry, 6 passed).
3. Checklist mirrors the issue's Wave 0 plan — **PASS** (Q1 keeps
   `EnrichDomain` closed, so "opened per Q1" resolves to a deliberate no-op;
   the policy-rule and consent tables land ahead of Waves 2–3 by the
   single-schema-owner decision, disclosed above).

Auditor's minor findings (backfill story and the poly-refs exclusion were
unnarrated) were folded into `## What changed` after the audit.

## Files

- `packages/vault/src/schema/enrich.ts`
- `packages/vault/src/schema/tables.ts`
- `packages/vault/src/schema/poly-refs.ts`
- `packages/vault/src/enrich/derivation.ts`
- `packages/vault/src/enrich/derivation.test.ts`
- `packages/vault/src/enrich/policy-rules.ts`
- `packages/vault/src/enrich/policy-rules.test.ts`
- `packages/vault/src/enrich/egress-consent.ts`
- `packages/vault/src/enrich/egress-consent.test.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/index.ts`
- `packages/server/src/enrich/capability-registry.ts`
- `packages/server/src/enrich/capability-registry.test.ts`
- `tests/schema-export-fingerprint.json`
- `tests/quality/classification-ratchet.json`
- `tests/experience-budgets/client-query-counts.json`
- `docs/photos/derived-ledger.md`
- `docs/decisions.md`
- `packages/server/src/enrich/engine-profiles.ts`
- `packages/server/src/enrich/engine-profiles.test.ts`
- `packages/server/src/routes/enrich-profiles-routes.ts`
- `packages/server/src/routes/enrich-profiles-routes.test.ts`
- `packages/server/src/serve/build-gateway.ts`
- `packages/server/src/serve/build-gateway.test.ts`
- `packages/server/src/routes/route-security.ts`
- `docs/config-ownership.md`
- `packages/server/src/automation/fire/enrich-resolve.ts`
- `packages/server/src/automation/fire/enrich-resolve.test.ts`
- `packages/server/src/automation/fire/enrich-gate.ts`
- `packages/server/src/automation/fire/enrich-gate.test.ts`
- `packages/server/src/automation/fire/fire.ts`
- `packages/server/src/automation/index.ts`
- `packages/server/src/routes/vault-routes.ts`
- `packages/server/src/routes/vault-enrich-rules-routes.ts`
- `packages/server/src/routes/vault-enrich-rules-routes.test.ts`
- `packages/vault/src/enrich/policy.ts`
- `packages/vault/src/enrich/enrich.test.ts`
- `packages/client/src/enrich-policy.ts`
- `packages/client/src/gateway-client-vault.ts` (enrichment section split into
  `packages/client/src/gateway-client-vault-enrich.ts`, re-exported — file-size
  directive)
- `packages/client/src/gateway-client-seam-fixtures.ts`
- `packages/client/src/gateway-client-enrich.contract.test.ts`
- `docs/blueprint-seats.md`
- `packages/server/src/enrich/egress-consent-lookup.ts`
- `packages/server/src/enrich/egress-consent-lookup.test.ts`
- `packages/vault/src/commands/enrich.ts`
- `packages/client/src/gateway-client-vault-enrich.ts`
- `packages/client/src/react/screens/ApprovalsScreen.tsx`
- `packages/client/src/react/screens/ApprovalsScreen.test.tsx`
- `packages/client/src/react/shell/routes/approvalsData.ts`
- `packages/client/src/react/shell/routes/approvalsData.test.ts`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `apps/mobile/src/screens/Scan.tsx`
- `packages/client/src/react/shell/routes/ApprovalsRoute.test.tsx`
- `apps/mobile/src/screens/Settings.tsx`
- `apps/mobile/src/screens/settings/EnrichmentSection.tsx`
- `apps/mobile/src/screens/settings/EnrichmentSection.test.tsx`
- `apps/mobile/src/lib/enrichment.ts`

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-17 | claude-code | 97726ea0-2cc1-5450-a046-cac6be0b3d6a |
