//! `enrichment-status` — **a read-only mirror of `enrich.policy`**
//! (D-1020-P4).
//!
//! A straight read of the `enrich_policy` row keyed on the `photos` domain,
//! never the settings bag (which stays owner-only behind
//! `GET/PATCH /centraid/_vault/enrich`). The app can *see* the tier and cannot
//! set it: there is no `enrich.set_policy` in Photos' action table.
//!
//! ## The tier vocabulary, and one compatibility shim
//!
//! `tier ∈ off | device | gateway` (#712 C5). The column's CHECK also admits
//! `local` and `model`, the pre-#712 names, **as a READ compatibility shim
//! only** — a vault written by an older build must still open. [`Tier::parse`]
//! maps them forward and [`Tier::as_str`] never spells them, so a port cannot
//! write one back.
//!
//! ## Absent is `off`, and denied is neither
//!
//! v0 answers `{tier: row?.tier ?? "off"}` — **no policy row means enrichment
//! is off**, which is the right default and is not the same as "we could not
//! read it". A denial answers `{tier: null, vaultDenied}`, and the surface says
//! so rather than telling a member their recognition is switched off when the
//! truth is that the app lost its grant. [`EnrichmentStatus`] is therefore a
//! [`crate::Reading`] over a [`Tier`] and never an `Option<Tier>`.
//!
//! ## The ask only fires when the tier is not `off`
//!
//! `request-enrichment` writes a PRIORITY HINT, never a gate: a recipe with an
//! empty queue still walks the library behind its cursor
//! (`docs/recognition-automations.md:37`). So when the tier is `off` the UI
//! says so plainly rather than showing a button that would silently no-op —
//! [`Tier::accepts_priority_ask`] is that rule, in one place.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_by_id};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::PageQuery;

use crate::Reading;

/// The domain this app mirrors. `enrich_policy.domain`'s CHECK is
/// `('photos','docs')`; Photos reads its own and no other.
pub const DOMAIN: &str = "photos";

/// Where recognition for this domain is allowed to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Tier {
    /// Nothing runs. The default when there is no policy row at all.
    #[default]
    Off,
    /// Today: the gateway's deterministic engine with `ctx.delegate` sealed.
    /// **Not "runs on the phone"** — that is open question 9's third execution
    /// site, and it does not exist yet
    /// (`contracts/apps/photos/recognition-placement.md`).
    Device,
    /// The gateway's full engine, model turns included.
    Gateway,
}

impl Tier {
    /// The column's spelling, with the two retired names read forward.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "off" => Some(Self::Off),
            // `local` was the pre-#712 name for the deterministic lane.
            "device" | "local" => Some(Self::Device),
            // `model` was the pre-#712 name for the model lane.
            "gateway" | "model" => Some(Self::Gateway),
            _ => None,
        }
    }

    /// The CURRENT spelling. There is no way to write `local` or `model` back.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Device => "device",
            Self::Gateway => "gateway",
        }
    }

    /// Rank, for the `rank(lane) ≤ rank(tier)` gate the fire path applies
    /// (`packages/server/src/automation/fire/enrich-gate.ts:1-39`).
    #[must_use]
    pub const fn rank(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Device => 1,
            Self::Gateway => 2,
        }
    }

    /// Whether the "Prioritize faces" ask does anything. `false` for `off`, and
    /// a surface must say so rather than offering a button that no-ops.
    #[must_use]
    pub const fn accepts_priority_ask(self) -> bool {
        !matches!(self, Self::Off)
    }
}

/// What `enrichment-status` answers: three states, not an `Option`.
pub type EnrichmentStatus = Reading<Tier>;

/// The statement, verbatim from `enrichment-status.ts:22-31`. One row, asked
/// for as one row: `enrich_policy` is keyed on the domain.
#[must_use]
pub fn policy_statement() -> PageQuery {
    // `read_by_id` builds the statement; this exposes the same shape for the
    // plan snapshot and the parity fixture to name.
    PageQuery::new(
        "photos.enrichment.policy",
        "domain, tier, updated_at",
        "enrich_policy",
        centraid_apps_kit::statement::PageOrder::asc("domain", "domain"),
    )
    .filter(
        "domain = ?",
        vec![centraid_apps_kit::statement::PageBindValue::Text(
            DOMAIN.to_owned(),
        )],
    )
}

/// Read the mirror.
///
/// An `Err` here is the DOOR being absent, which the caller renders as
/// [`Reading::Denied`] with the code the door gave it. A vault that answers
/// "no such row" is `Tier::Off`, which is data.
pub fn enrichment_status(door: &dyn PageDoor) -> KitResult<EnrichmentStatus> {
    let row = read_by_id(
        door,
        "photos.enrichment.policy",
        "domain, tier, updated_at",
        "enrich_policy",
        "domain",
        DOMAIN,
    )?;
    Ok(Reading::Data(fold_policy(row.as_ref())))
}

/// THE FOLD. No row, or a tier spelling outside the CHECK, is `off`.
///
/// An unreadable spelling folding to `off` is deliberate and is v0's answer
/// too (`row?.tier ?? "off"` over a column whose CHECK cannot hold anything
/// else): the failure-safe direction for a recognition switch is *not running*.
#[must_use]
pub fn fold_policy(row: Option<&centraid_apps_kit::row::Row>) -> Tier {
    row.and_then(|row| text_of(row, "tier"))
        .as_deref()
        .and_then(Tier::parse)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Denial;
    use centraid_apps_kit::row::{Cell, Row};

    fn row(tier: &str) -> Row {
        let mut row = Row::new();
        row.insert("domain".to_owned(), Cell::Text(DOMAIN.to_owned()));
        row.insert("tier".to_owned(), Cell::Text(tier.to_owned()));
        row
    }

    #[test]
    fn no_policy_row_means_off_and_off_is_a_default_not_a_failure() {
        assert_eq!(fold_policy(None), Tier::Off);
        assert!(!Tier::Off.accepts_priority_ask());
    }

    /// A DENIAL IS NOT `off`. Telling a member their recognition is switched
    /// off when the app lost its grant is the bug this type prevents.
    #[test]
    fn a_denial_is_a_third_state_and_not_the_off_tier() {
        let denied: EnrichmentStatus = Reading::Denied(Denial {
            code: Some("VAULT_ACCESS".to_owned()),
            message: Some("this app's grant was revoked".to_owned()),
            revoked_at: None,
        });
        assert!(denied.denied());
        assert_eq!(denied.data(), None);
        let off: EnrichmentStatus = Reading::Data(Tier::Off);
        assert!(!off.denied());
        assert_eq!(off.data(), Some(&Tier::Off));
        assert_ne!(denied, off);
    }

    #[test]
    fn the_retired_tier_names_are_read_forward_and_never_written_back() {
        assert_eq!(fold_policy(Some(&row("local"))), Tier::Device);
        assert_eq!(fold_policy(Some(&row("model"))), Tier::Gateway);
        // And neither spelling can come back out.
        for tier in [Tier::Off, Tier::Device, Tier::Gateway] {
            assert!(!["local", "model"].contains(&tier.as_str()));
        }
    }

    #[test]
    fn an_unreadable_tier_fails_towards_not_running() {
        assert_eq!(fold_policy(Some(&row("everywhere"))), Tier::Off);
    }

    #[test]
    fn the_priority_ask_fires_for_every_tier_but_off() {
        assert!(!Tier::Off.accepts_priority_ask());
        assert!(Tier::Device.accepts_priority_ask());
        assert!(Tier::Gateway.accepts_priority_ask());
        assert!(Tier::Device.rank() <= Tier::Gateway.rank());
    }

    #[test]
    fn the_statement_names_the_domain_and_reads_three_columns() {
        let query = policy_statement();
        assert_eq!(query.r#where.as_deref(), Some("domain = ?"));
        assert_eq!(query.bind.len(), 1);
        assert!(query.select.contains("tier"));
    }
}
