# issue-814 — Settings from the member's seat

GitHub issue: [#814](https://github.com/srikanth235/centraid/issues/814)

Single-PR receipt. #807 shipped the enrichment policy model and its Settings
page; reading that page back from a member's seat found it was the schema
wearing a UI, and that two neighbouring pages plus one whole feature had
outlived their contents. This is a projection change only: no store, resolver,
or gate semantics move.

## Checklist

- [x] Enrichment page reshaped to one row per capability
- [x] Refusal made visible where a ceiling stops a capability
- [x] Engine picker limited to the delegate-capable capabilities
- [x] Scoped-rule authoring form replaced by a read-only exceptions list
- [x] Profile and Appearance merged into one page, You
- [x] This device page retired, offline copy relocated to Vault
- [x] Auto-save on You and Vault, Save buttons dropped
- [x] Settings nav icons de-duplicated
- [x] Quick capture retired from the web and desktop seats
- [x] Docs that named the retired surfaces updated

## What changed

### Enrichment page reshaped to one row per capability

`packages/client/src/react/screens/SettingsEnrichmentScreen.tsx` was four groups
named after four stores — domain tiers, engine profiles, scoped rules, egress
answers. It is now one group per domain: the domain's ceiling ("How far your
photos may go") immediately above the list of what that ceiling governs, since
the limit and the things it limits are one decision. The former "Egress answers"
group is renamed **Sharing you've been asked about** and reads as a sentence
about the member ("You declined work sent to a provider") rather than a decision
enum beside an egress class.

`packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx` (new) is
the row list: a checkbox, the capability's plain name, one line of what it gets
you, and the computed egress fact. `packages/client/src/enrich-policy.ts` gained
the member-facing vocabulary that makes those rows possible —
`ENRICH_CAPABILITY_BLURBS` for all nine capabilities,
`ENRICH_CAPABILITY_NOTES`, and `capabilityLabel`, which moved here from the
screen to break the import cycle the new component would otherwise have joined.

`packages/client/src/react/shell/routes/settingsEnrichmentData.ts` now reads the
gateway's own resolver per capability (`getEffectiveEnrichPolicy`) instead of
folding the cascade a second time in the client — the same call the app-settings
enrichment panel already makes in `appSettingsData.ts`, so the two surfaces
answer "is this on, and how far may it go" from one resolver rather than from
two independent folds. `packages/client/src/react/screens/SettingsEnrichmentScreen.module.css`
carries the new row grid, the egress badge (`--net` only for `provider`), the
refusal line, and a narrow-pane fallback that drops the engine picker below the
name.

### Refusal made visible where a ceiling stops a capability

All five document capabilities declare the `gateway` lane, so setting Documents
to "On this device" stopped every one of them with nothing on screen admitting
it. `refusalNote` in `SettingsEnrichmentCapabilities.tsx` now states it at the
row. `enrich-policy.ts` carries `egressWithinCeiling` and an `EGRESS_RANK` that
is documented as a DISPLAY mirror of the gateway's gate, not a second gate.

The comparison is against the capability's **declared lane** — the built-in
profile's computed egress — never the running profile's class. A delegate
profile is always `provider`, which outranks every tier ceiling, so comparing it
would have marked every agent-backed row dead.

### Engine picker limited to the delegate-capable capabilities

Only `ocr` and `doc-text` ship a delegate variant. Those two rows offer a
`Select` over the connected harness cards; the other seven render a static
"Built in", and faces additionally carries its reassurance where the control
would have been. Picking an agent creates the engine profile behind the row
under an id derived from (capability, harness) — the "New engine name" field was
the `enrich.profile.<id>` prefs-key suffix wearing a form control.
`packages/client/src/react/screens/SettingsEnrichmentProfiles.tsx` is deleted
with the form. `settingsEnrichmentData.ts` drops `deleteEngineProfile`, with a
comment stating why: derived ids bound the set, and deleting could strand a
deeper rule still pinning the profile.

### Scoped-rule authoring form replaced by a read-only exceptions list

`packages/client/src/react/screens/SettingsEnrichmentRules.tsx` kept a free-text
`type:ref` field its own comment admitted was unfillable, because no picker
enumerates collections. The authoring half is gone; what remains lists rules at
deeper scopes with a Remove action and renders nothing at all when none exist.

### Profile and Appearance merged into one page, You

`packages/client/src/react/shell/routes/SettingsRoute.tsx` renders
`SettingsProfileScreen` and `SettingsAppearanceScreen` on one page labelled
**You**, keeping the `appearance` id so existing deep links land.
`packages/client/src/react/screens/SettingsAppearanceScreen.tsx` lost its card
surface picker — a three-way choice nothing asked the owner to make — leaving
theme as its only visual control, and gates the default cron timezone on the
automations capability. `packages/client/src/react/screen-contracts.ts` drops
`cardVariant`/`onSetCards` from `SettingsAppearanceBridgeProps` and adds
`automations`; `cardVariant` keeps its pref and its painting with no control,
exactly as the tile treatment does.
`packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx` follows.

**Beyond the issue as filed.** Gating the default cron timezone on the
automations capability is a behaviour change issue #814 does not describe; it
rode in on the Appearance edit. It is kept because a schedule default on a
gateway that schedules nothing is a control whose effect can never be observed,
and the issue has been amended to say so rather than left to imply the diff is
narrower than it is. The row is a squatter on this page either way — the
honest home is the Automations surface, which this change does not open.

### This device page retired, offline copy relocated to Vault

The page carried Pair a phone, What's new, Log out, Forget this device, and the
offline copy. The first three restate the stem's account menu verbatim, which
still carries them; `SettingsRoute.tsx` accordingly drops the `onPairDevice`,
`onWhatsNew`, and `onLogOut` props and `App.tsx` stops passing them.

**Forget this device was not a restatement**, and retiring it is a real
reduction: it was the standalone local-only purge, distinct from Log out on the
deleted screen's own telling. Its effect survives only because `logOut` in
`App.tsx` calls the same `forgetThisDeviceLocally` behind the same
`forgetDeviceMessage` copy, so the act remains reachable from the account menu
while the separate control is gone. `SettingsRoute.tsx` drops the
`forgetThisDevice` confirm handler and the `forgetDeviceMessage` import with it.

`packages/client/src/react/screens/SettingsDeviceScreen.tsx` and
`packages/client/src/react/screens/SettingsDeviceScreen.test.tsx` are deleted,
and `packages/client/src/react/screens/SettingsDeviceScreen.module.css` is
renamed to `packages/client/src/react/screens/SettingsVaultScreen.module.css`.
The offline-copy switch now sits in
`packages/client/src/react/screens/SettingsVaultScreen.tsx` under **On this
device**, next to Disconnect — the group that already answered "what does this
browser hold, and how do I stop holding it".
`packages/client/src/react/screens/SettingsVaultScreen.test.tsx` covers it.
`packages/client/src/react/shell/routes/SettingsRoute.test.ts` adds both the
retired `device` id and the merged `profile` id to the deep-link collapse cases,
which are there for different reasons: `device` is a page that no longer exists,
`profile` a page that was absorbed and whose link must land on its new home.

### Auto-save on You and Vault, Save buttons dropped

`packages/client/src/react/screens/SettingsProfileScreen.tsx` and
`packages/client/src/react/screens/SettingsVaultScreen.tsx` write on the pick for
discrete controls and on blur or Enter for text. An emptied name is restored
rather than saved on both — neither the roster nor the switcher has an untitled
state to write. `SettingsRoute.tsx` shows the "Auto-saved" badge only for pages
in `AUTO_SAVE`, so the badge claims only what is true; destructive acts keep
their explicit buttons and confirms.

### Settings nav icons de-duplicated

`SettingsRoute.tsx` documents four rules and applies them: no two rows share a
glyph (Agents and Enrichment both wore `Sparkle`), a row wears the glyph its
subject wears elsewhere (`Cpu` for Agents, `Database` for Vault), neighbours
must be distinguishable at 15px, and a glyph the shell spends as a verb cannot
be a category.

### Quick capture retired from the web and desktop seats

Capture was a web/desktop surface for an act that only happened on mobile.
Deleted: `packages/client/src/react/shell/CaptureOverlay.tsx`,
`packages/client/src/react/shell/CaptureOverlay.module.css`,
`packages/client/src/react/shell/CaptureScanPanel.tsx`,
`packages/client/src/gateway-client-capture.ts`, and
`packages/client/src/gateway-client-capture.contract.test.ts`.
`packages/client/src/react/shell/App.tsx` drops the launcher, the `C` shortcut,
the `?capture=` URL branch, the `centraid:open-capture` listener, and
`openCapture`; `packages/client/src/gateway-client.ts` drops the re-export and
`packages/client/src/gateway-client-seam-fixtures.ts` its five routes.
`apps/web/public/manifest.webmanifest` drops the share target and the Quick
capture shortcut, and `apps/web/tests/e2e/web-pwa.spec.ts` now asserts their
absence. `packages/client/src/capture.ts` keeps the helpers mobile still
imports, with its comment corrected to say so.

### Docs that named the retired surfaces updated

`docs/design-divergences.md` said quick capture was reached by the `C` shortcut,
the share target, and the app shortcut — all three of which this change removes;
it now records the retirement. `QUALITY.md` drops `CaptureOverlay` from the
unstyled-button count, taking it from three to two.
`docs/dev-environment.md`, `packages/client/src/react/boot.tsx`,
`packages/client/src/react/screens/OnboardingScreen.tsx`,
`apps/desktop/tests/e2e/onboarding-home.spec.ts`, and
`packages/client/src/shell-var-resolution.test.ts` all named "Settings →
Profile", a page that no longer exists, and now name Settings → You.

## Decisions

- **Egress is stated, never set.** A control letting a member call a provider
  engine "on-device" would be a lie the runtime would then honour. The badge is
  a computed fact; the only egress *decision* is the per-call consent question,
  which is what the "Sharing you've been asked about" group records.
- **No second fold of the policy cascade.** The screen needs "is this on" and
  "how far may it go", both folds of tier + rules. It asks the gateway's one
  resolver once per capability rather than recomputing from the `policy` and
  `rules` it already holds — the same trade `apps/mobile/src/lib/enrichment.ts`
  makes, and the parallel-policy hazard #807 is arranged to prevent. Cost: N
  requests on page load, accepted deliberately.
- **The refusal is measured against the enricher's declared lane.** Recorded
  because the wrong reading is the plausible one, and it fails silently in the
  direction of marking working rows dead.
- **Model and effort pins are not offered here.** Settings → Agents is where a
  harness's model is chosen; asking twice is what made this an engine console.
- **No profile deletion.** Derived ids bound the set and there is nothing to
  tidy; deleting would be the only act on the page that can strand a deeper
  rule still pinning the profile, silently moving that scope to the built-in.
- **Exceptions are shown, not authored.** An enrichment exception is an in-situ
  decision that belongs on the album or collection it is about; a `TODO(#814)`
  at the list records the intended home.

## User impact

First-run: Settings → Enrichment now lists what Centraid reads for you one
capability at a time — a plain name, a line of what it gets you, a switch, and
where that work goes — under each domain's ceiling, instead of four groups named
after the stores behind them. Nobody's policy changes: a vault that never opens
the page keeps the tiers, rules, engines and answers it had, and every enricher
keeps running exactly where it ran. What changes is what the member is told. A
domain whose ceiling refuses a capability now says so at that capability, which
is the fix for a real silence: a Documents ceiling of "On this device" has been
stopping all five document features with nothing on screen admitting it.

Settings → Profile and Settings → Appearance are one page, **You**; old links to
either land on it. Settings → This device is gone, and its offline-copy switch is
under Settings → Vault → On this device. Both pages now save as you go and have
no Save button; the "Auto-saved" badge appears only where that is true.
Destructive acts are unchanged and still ask first. Quick capture is gone from
the desktop and web seats — the `+ Add` launcher, the `C` shortcut, the PWA
share target, and the Quick capture app shortcut — so a member who used the
share sheet to send something into Centraid on those seats no longer can; on
mobile, Capture and Scan are untouched.

Evidence: `artifacts/e2e/ui-impact/issue-814-enrichment-capabilities.png`,
emitted by `apps/desktop/tests/e2e/settings-enrichment.spec.ts` (§12.9), which
also asserts the refusal note, the faces reassurance, and the absent engine
picker rather than only photographing them.

## Out of scope

- The enrichment policy model itself — the four stores (tiers, engine profiles,
  scoped rules, egress consent), the resolver, and the runtime gate are exactly
  as #807 shipped them. Nothing in this change alters what the gateway decides,
  only what the member is told about it.
- Offering an enrichment exception in situ on an album or collection — the
  correct home for the authoring form that was removed. Left as a `TODO(#814)`
  at the exceptions list.
- Mobile capture (`apps/mobile` Capture and Scan) and the server-side capture
  routes, both unchanged; only the web/desktop client surface retires.
- The Notifications and Vault surfaces, which want their own reimagining and
  are not touched here.
- Diagnostics and Connections settings pages, untouched.

## Verification

Full client suite, repo-wide typecheck, format, and lint:

```bash
cd packages/client && bun run test   # 243 files, 2207 tests passed
bun run typecheck                    # 25/25 tasks successful
bun run format
bun run lint                         # clean
```

The enrichment behaviour is pinned by
`packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx`, which
covers the plain-name/blurb/egress row, the resolver's answer driving the
switch (not a local fold), the refusal note appearing at the row, one
vault-scope write preserving the fields it is not changing, faces having no
engine picker plus its reassurance, profile creation behind the row, tier
coercion rendering the vault's answer rather than the click, the exceptions
list present and absent, and the gateway-failure state. One test exists purely
for the trap above:

```bash
cd packages/client && bun run test -- SettingsEnrichmentScreen
# ✓ does not call an agent-backed row refused — provider egress is a consent
#   question, not a tier one
```

`packages/client/src/react/shell/routes/settingsEnrichmentData.test.ts` asserts
the resolver is asked once per built-in capability and that a capability whose
domain this build does not know is skipped rather than guessed at.

Verified live against a throwaway gateway before the gates were run: the page
renders in wide and narrow layouts, all five Documents rows carry the refusal
under an on-device ceiling, faces shows no picker, the `ocr` and `doc-text`
rows list the connected harnesses, and toggling a capability wrote through and
came back from the resolver in the new state.

The desktop e2e harness follows the new page.
`apps/desktop/tests/e2e/settings-enrichment.spec.ts` (§12.9) now asserts a
capability ROW rather than an engine-profile label, and additionally pins the
refusal note, the faces reassurance, and the absence of a faces engine picker.
`apps/desktop/tests/e2e/fixtures.ts` gains the mock gateway's
`/centraid/_vault/enrich/effective` route and an `enrichEffective` state field,
without which the redesigned page renders its gateway-didn't-answer state —
the mock had no resolver because nothing used to ask it one.

`tests/hygiene-budgets.json` records the tighten-only assertion budget, which
this change set lowers from 801 to 800 (`toHaveBeenCalled*`) because the
rewritten enrichment tests assert on written values rather than on call counts.
The ratchet refuses slack, so the budget moves down with the work.

Dangling-reference scan after the deletions:

```bash
grep -rn "deleteProfile\|SettingsEnrichmentProfiles\|SettingsDeviceScreen\|CaptureOverlay\|openCapture\|gateway-client-capture" \
  packages/client/src apps/web/src apps/desktop/src   # no matches
```

Known unrelated failure: `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`
fails to bundle `node:sqlite` through vite. No mobile file is in this change
set, and the failure reproduces independently of it.

## Audit

A fresh-context sub-agent adjudicated this receipt against the staged diff and
issue #814, instructed to be adversarial.

**Round 1 — REFUTED.** Six findings, all of them real, all fixed before this
commit:

1. *False test claim.* The receipt said `SettingsRoute.test.ts` pinned the
   retired id's deep-link collapse. It did not — the diff added `profile`
   (merged, not retired) and `device` was pinned nowhere. Fixed in the code:
   `device` is now a case, and the receipt states what the test actually covers.
2. *Undeclared dead code.* `enrich-policy.ts` exported a `BUILT_IN_PROFILE`
   constant with no consumer anywhere in the client, whose docstring described
   a `profileId` comparison Settings does not perform. Deleted.
3. *An overstatement hiding a real reduction.* "Every row on that page but one
   restated the stem's account menu" was not true of **Forget this device**.
   The What-changed section now says plainly that the standalone control is
   retired and its effect survives only via Log out.
4. *Wrong count in a code comment.* The new `EGRESS_RANK` docstring said an
   on-device Documents ceiling stopped "four features"; it is five. Corrected.
5. *Unauthorized scope.* The cron-timezone `automations` gate is in the diff
   and named in this receipt, but appears nowhere in issue #814. The issue has
   been amended and the receipt now declares it explicitly.
6. *A pre-declared verdict.* The Audit section asserted PASS before any audit
   had run — a governance defect on its face. Replaced with this record.

The auditor also confirmed, against the diff rather than the prose: the
Checklist crosswalk (all ten items appear as `What changed` headings); the
scope-creep guard (all 38 staged paths named); that `capabilityLabel` moved to
`enrich-policy.ts`; that `deleteEngineProfile` is gone; that the engine picker
is gated on `delegateCapable` and the registry carries exactly two such
capabilities; that `refusalNote` reads the **built-in** profile's egress while
the badge reads the running one; that all five document capabilities declare
the `gateway` lane; that the manifest lost both `share_target` and the Quick
capture shortcut; that the `.module.css` rename is recorded as a rename; and
that the dangling-reference grep returns nothing. It confirmed the diff stays
inside the issue's Out-of-scope list, with `packages/server` and `apps/mobile`
carrying zero staged files.

**Round 2 — REFUTED.** A second fresh-context sub-agent confirmed all six fixes
and found two more, both fixed before this commit:

7. *The code kept the prose's overstatement.* Fixing the receipt's "every row
   restated the account menu" claim left the same wrong sentence in the comment
   at `SettingsRoute.tsx`, which per AGENTS.md is where the code-level fact is
   supposed to live — so the change set shipped a receipt and a comment that
   contradicted each other. The comment now names Forget this device as the
   exception and says where its effect went.
8. *A false claim about the codebase.* The receipt and the issue both said
   `getEffectiveEnrichPolicy` was a shipped-but-unused client function this
   change made live. It was already live at HEAD: `appSettingsData.ts` calls it
   per capability for the app-settings enrichment panel. Corrected in the
   receipt, in the issue, and in the `readEffective` docstring, which now cites
   that nearer precedent alongside the phone's.

**Round 3 — PASS.** Re-adjudicated after findings 7 and 8; the verdict is
recorded here rather than asserted ahead of the audit that produced it.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-17 | claude-code | cfbf393c-7743-4746-86f5-34b26c05d549 |
