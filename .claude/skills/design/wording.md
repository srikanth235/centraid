# Wording

**Copy is signage, not conversation**: calm, concrete, specific, read at a glance. "Photo deleted" is the register; "Deleted" drops the noun and "Your photo has been successfully deleted." pads a fact. Copy lives in the Rust string catalogue, `crates/screens/src/strings`, and only there; the kit's fixed words (`strings/shared.rs`) are emitted into both shells' `Words` tables, and the assistant's turn sentences are `copy/chat.json`. **Every word on a board exists in the core's strings**, or is added there in the PR that builds the screen. `scripts/lint-copy.mjs` enforces the rest.

Members read _backup device_; code and docs say _gateway_.

| Surface | Budget |
| --- | --- |
| Button, action, menu row | 1–2 words, verb first |
| Status line, outcome | a fragment ("Photo deleted"), never "successfully" |
| Status line, state | one clause |
| Empty state | one sentence and at most one action; no feature explanation. Where the phone holds the data, its import is the one action. The glyph on its wash is the app's own, except a trash's, which wears the Trash glyph (`EmptyState.icon_key`) |
| Banner (offline, degraded) | one sentence: the state, plus one action or one consequence |
| Error | what happened and what to do, about 12 words or fewer; no apology, no "Please try again." |
| Settings label + description | the label carries the meaning; the description is one sentence or absent |
| Placeholder | a short noun phrase |
| Consent, destructive confirm, security or privacy disclosure | full sentences: the one home for reassurance |

- **Banned everywhere**: "please", "successfully", "simply", "in order to", "you can", "we're sorry".
- **Defensive reassurance** (a fact followed by what was not lost, deleted or sent) belongs only where the risk decision is made, and a disclosure keeps its full sentence there. A status line, empty state or shelf header repeating the promise is noise.
- **One noun per thing**, the same on every seat; a short form may drop words from the full name, never swap one in. A vault is never the actor.

| Say | Never |
| --- | --- |
| backup device | gateway, laptop, machine, NAS, server |
| recovery key | 24 words, seed, phrase, passphrase |
| QR code (button "Scan QR code"), pairing code | square, payload |
| this phone | this device |
| photo | photograph |
| backed up | synced, sealed, drained, copied to the gateway |
| Try again | Retry |

A literal command the member types stays as written (`centraid-gateway pair`), and where the member types the key, "the 24 words of your recovery key" is fine. Internals are not copy: never seal/unseal, receipt, ledger, drain, "derived", "at rest" or `core.*`. Do not hard-code counts that rot ("Eight apps").

Hard caps in words, by key suffix (a `{placeholder}` is one word): `_LABEL`, `_ACTION`, `_PRIMARY`, `_SECONDARY`, `_BUTTON` 4; `_NOTE`, `_DETAIL`, `_LEDE`, `_STATUS`, `_HINT` 12; `_BODY`, `_LEAD`, `_NOTICE` and errors 25; `_TITLE` 6. A `·` never joins two thoughts in one string; it survives only between short metadata facts ("Edited · 3 days ago").

Worked pairs ([#805](https://github.com/srikanth235/centraid/issues/805)): "Photos Memories empty state" went from three sentences to "Your own photos, noticed — a year behind a day, a trip, a burst."; a write failure went from "<title>: Please try again." to "<title>. Try again." Audit everything, churn nothing: a string already inside its budget is left alone.

## Contract

- **Copy is a contract.** Calm, concrete, confident, short, sentence case ("Photo deleted", not "Your photo has been successfully deleted"). One noun per destination and the screen title wins. No exception string is ever shown; the core builds the sentence from a code. State each ontology fact once, where the member first meets it.
- **Member-facing screens name no host, transport or engine state.** A gateway is named only where the member manages one. The vault lockup says where the vault stands, derived and never stored.
