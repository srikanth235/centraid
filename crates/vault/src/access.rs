//! Who is asking, and what the answer narrows to (D-1020-D1-9).
//!
//! **A deny is an outcome, not an exception.** The authority plane's job is to
//! answer, and an answer that arrives as a panic cannot be receipted — so
//! [`evaluate_access`] returns a [`Decision`] and the crate has no
//! `VaultError::Denied`.
//!
//! ## Enrollment is full trust (#996 R11)
//!
//! There is no `share_authority` join for a device. An enrolled device has a
//! row in `access_device_secret` whose public key matches, and revoking DELETES
//! that row — so **unknown and revoked are the same refusal**. That is not laxity:
//! the alternative was a per-device authority plane nobody could read, and the
//! thing a member actually does is revoke the device.
//!
//! ## The order of judgement, and why it is this order
//!
//! 1. A read-only device asking to `act` is denied first, because
//!    the answer does not depend on anything else.
//! 2. The execution clamp narrows **whoever holds it**, owner included. An app
//!    is the owner's own screen and holds no grant, but it does hold a declared
//!    reach, and that reach is a ceiling.
//! 3. An owner device is allowed, with `authority_id: None` — owner-direct,
//!    narrowed by its clamp if it holds one. It is the only caller there is.
//!
//! The agent, assistant and automation steps that stood between these, and
//! the `share_authority` reader the last of them used, went with those callers
//! (#1029 §1); [`judge`]'s own comments keep the old step numbers where they
//! stood.
//!
//! ## There is no reveal judgement (#1020, D-1020-L2; #1047, R-1047-D2)
//!
//! [`Verb`] has two arms, `read` and `act`, and nothing here judges a reveal.
//! #1020 kept a third, private arm behind `evaluate_reveal` and a
//! `SealedSubject` that could not be built for `locker`, so the one sealed
//! class a host could reveal was the connector credential. Rung five dropped
//! that table with the connector plane and nothing called the door, so it is
//! deleted (R-1047-D2). A Locker cell is opened only by the core holding `K`
//! (`crates/core/src/locker`), behind the member's unlock and after
//! `locker.reveal_receipt`; the access plane has no path to one to refuse.

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::error::{Result, VaultError};

/// What is being asked for.
///
/// **THERE IS NO `Reveal` ARM, AND THAT IS THE KEY DOOR'S DELETION**
/// (#1020, D-1020-L2). v0 had `GET /_vault/seat/locker-key` and a policy check
/// that refused the `locker` schema for every principal including the owner.
/// A policy check is a line somebody can move; the trust premise asks for
/// something a code path cannot *express*, and here no verb, subject or
/// judgement for a reveal exists at all (R-1047-D2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verb {
    Read,
    Act,
}

impl Verb {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Act => "act",
        }
    }

    /// Does a granted verb satisfy a requested one?
    ///
    /// `read` is satisfied by `read` or `read+act`, `act` by `act` or
    /// `read+act`. A granted `reveal` — v0's spelling of a fourth grant —
    /// satisfies neither, so it can never widen a read.
    #[must_use]
    pub fn satisfied_by(self, granted: &str) -> bool {
        match self {
            Self::Read => matches!(granted, "read" | "read+act"),
            Self::Act => matches!(granted, "act" | "read+act"),
        }
    }
}

/// Which columns a reader may project. `None` is every column.
pub type FieldMask = Option<BTreeSet<String>>;

/// One compiled row filter: a column pinned to a value or to a set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowFilter {
    pub column: String,
    /// A single-element list is an `=`; more than one is an `IN`. One shape,
    /// because a bounded union must be ONE `in` filter — two `=` filters ANDed
    /// select nothing, which is the contradiction the clamp refuses.
    pub values: Vec<String>,
}

/// One scope of an execution clamp: what an app or agent declared it reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub schema: String,
    /// `None` covers every table of the schema.
    pub table: Option<String>,
    /// The granted verb, in v0's spelling: `read`, `act`, `read+act`.
    pub verb: String,
    pub row_filter: Vec<RowFilter>,
    pub field_mask: FieldMask,
}

impl Scope {
    #[must_use]
    pub fn covers(&self, schema: &str, table: &str, verb: Verb) -> bool {
        self.schema == schema
            && self.table.as_ref().is_none_or(|named| named == table)
            && verb.satisfied_by(&self.verb)
    }
}

/// The ceiling a principal carries with it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeClamp {
    pub scopes: Vec<Scope>,
}

/// Who is asking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// An enrolled device acting as the owner.
    OwnerDevice {
        device_id: String,
        /// A read-only surface (a widget, a share extension) cannot act.
        may_act: bool,
        scope_clamp: Option<ScopeClamp>,
    },
    // TWO VARIANTS LEFT WITH THEIR CALLERS (#1029 §1). `Agent` was the
    // assistant and any ACP harness riding an owner, and `Automation` was a
    // compiled manifest running on a schedule. `crates/assist` and
    // `crates/automations` are deleted, so nothing in this workspace can
    // construct either — and an authority plane that still judged them would
    // be judging callers that cannot exist.
    //
    // `OwnerDevice` is therefore the only variant, and it is deliberately
    // still an enum: `may_act` and `scope_clamp` are real distinctions a
    // read-only surface (a widget, a share extension) makes on the phone, and
    // collapsing the type to a struct is a rename across every `match` in this
    // crate for no behaviour. W9 can make it one.
}

impl Principal {
    /// An owner device that may act and holds no clamp — the common case.
    #[must_use]
    pub fn owner(device_id: impl Into<String>) -> Self {
        Self::OwnerDevice {
            device_id: device_id.into(),
            may_act: true,
            scope_clamp: None,
        }
    }

    #[must_use]
    pub fn may_act(&self) -> bool {
        match self {
            Self::OwnerDevice { may_act, .. } => *may_act,
        }
    }

    #[must_use]
    pub const fn scope_clamp(&self) -> Option<&ScopeClamp> {
        match self {
            Self::OwnerDevice { scope_clamp, .. } => scope_clamp.as_ref(),
        }
    }

    /// The caller id that lands in `agent_command_invocation.caller_id`.
    #[must_use]
    pub fn caller_id(&self) -> &str {
        match self {
            Self::OwnerDevice { device_id, .. } => device_id,
        }
    }
}

/// The answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow {
        /// The `share_authority` row that allowed it; `None` is owner-direct.
        authority_id: Option<String>,
        row_filter: Vec<RowFilter>,
        field_mask: FieldMask,
    },
    Deny {
        /// The sentence an owner reads, naming what failed.
        failing: String,
        authority_id: Option<String>,
    },
}

impl Decision {
    #[must_use]
    pub const fn is_allow(&self) -> bool {
        matches!(self, Self::Allow { .. })
    }

    /// The row filters an allow narrows to, or an empty list.
    #[must_use]
    pub fn row_filter(&self) -> &[RowFilter] {
        match self {
            Self::Allow { row_filter, .. } => row_filter,
            Self::Deny { .. } => &[],
        }
    }
}

/// Judge one `(principal, schema, table, verb)`.
///
/// `connection` is read for the `share_authority` lookup only; the first five
/// steps need no query at all, which is why a clamped owner's read costs
/// nothing.
pub fn evaluate_access(
    connection: &Connection,
    principal: &Principal,
    schema: &str,
    table: &str,
    verb: Verb,
) -> Result<Decision> {
    judge(connection, principal, schema, table, verb)
}

fn judge(
    _connection: &Connection,
    principal: &Principal,
    schema: &str,
    table: &str,
    verb: Verb,
) -> Result<Decision> {
    let subject = format!("{schema}.{table}");

    // 1. A read-only surface cannot act.
    if matches!(verb, Verb::Act) && !principal.may_act() {
        return Ok(Decision::Deny {
            failing: format!(
                "this device is read-only and cannot {} {subject}",
                verb.as_str()
            ),
            authority_id: None,
        });
    }

    // 2. WAS "AN AGENT CANNOT EXCEED THE OWNER IT ACTS FOR" (#1029 §1). An
    //    agent rode an owner and was judged against it first, so a generous
    //    clamp on the agent could not outrun a restricted owner. There is no
    //    agent to ride one.

    // 3. THE EXECUTION CLAMP NARROWS WHOEVER HOLDS IT.
    let clamped = match principal.scope_clamp() {
        None => None,
        Some(clamp) => {
            let covering: Vec<&Scope> = clamp
                .scopes
                .iter()
                .filter(|scope| scope.covers(schema, table, verb))
                .collect();
            if covering.is_empty() {
                return Ok(Decision::Deny {
                    failing: format!(
                        "nothing in this caller's declared reach covers {} on {subject}",
                        verb.as_str()
                    ),
                    authority_id: None,
                });
            }
            Some(intersect(&covering)?)
        }
    };

    // 4. An owner device, which is the only caller there is.
    //
    //    5, 6 AND 7 WERE THE ASSISTANT, THE ORDINARY AGENT AND THE STANDING
    //    ANSWER (#1029 §1). The assistant held no standing answer and was
    //    allowed only while riding an acting owner; a non-assistant agent
    //    inherited the owner's answer narrowed by its own clamp; and an
    //    AUTOMATION was the only caller a `share_authority` row could ever
    //    answer for, matched on `principal_kind = 'automation'`. None of those
    //    three callers exists, which is why this is the last step and why the
    //    `share_authority` reader went with them.
    let (row_filter, field_mask) = clamped.unwrap_or_default();
    Ok(Decision::Allow {
        authority_id: None,
        row_filter,
        field_mask,
    })
}

/// Intersect the covering scopes: AND the filters, intersect the masks.
///
/// Order-independent, and it **refuses** when two scopes pin one column to
/// different single values. That is not a conservative choice — two `=` filters
/// ANDed select nothing, so silently intersecting them would turn "these two
/// groups" into "no rows", which reads as an empty screen rather than as a
/// misconfiguration. A bounded union must be one `in` filter.
fn intersect(scopes: &[&Scope]) -> Result<(Vec<RowFilter>, FieldMask)> {
    let mut filters: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for scope in scopes {
        for filter in &scope.row_filter {
            match filters.get(&filter.column) {
                None => {
                    filters.insert(filter.column.clone(), filter.values.clone());
                }
                Some(existing) => {
                    let narrowed: Vec<String> = existing
                        .iter()
                        .filter(|value| filter.values.contains(value))
                        .cloned()
                        .collect();
                    if narrowed.is_empty() {
                        return Err(VaultError::Invariant {
                            context: format!(
                                "two scopes pin `{}` to disjoint sets ({} and {}); a bounded union must be ONE `in` filter",
                                filter.column,
                                existing.join("|"),
                                filter.values.join("|")
                            ),
                        });
                    }
                    filters.insert(filter.column.clone(), narrowed);
                }
            }
        }
    }
    let mut mask: FieldMask = None;
    for scope in scopes {
        match (&mask, &scope.field_mask) {
            (_, None) => {}
            (None, Some(columns)) => mask = Some(columns.clone()),
            (Some(existing), Some(columns)) => {
                mask = Some(existing.intersection(columns).cloned().collect());
            }
        }
    }
    Ok((
        filters
            .into_iter()
            .map(|(column, values)| RowFilter { column, values })
            .collect(),
        mask,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare connection. It used to carry a `share_authority` stub, for the
    /// four deleted tests below; rung five drops that table (#1029) and the
    /// decisions this module takes never read one.
    fn memory() -> Connection {
        Connection::open_in_memory().expect("memory opens")
    }

    fn scope(schema: &str, verb: &str, values: &[&str]) -> Scope {
        Scope {
            schema: schema.to_owned(),
            table: None,
            verb: verb.to_owned(),
            row_filter: if values.is_empty() {
                Vec::new()
            } else {
                vec![RowFilter {
                    column: "group_id".to_owned(),
                    values: values.iter().map(|value| (*value).to_owned()).collect(),
                }]
            },
            field_mask: None,
        }
    }

    #[test]
    fn the_verb_algebra_never_lets_a_reveal_grant_widen_a_read() {
        assert!(Verb::Read.satisfied_by("read"));
        assert!(Verb::Read.satisfied_by("read+act"));
        assert!(!Verb::Read.satisfied_by("act"));
        assert!(Verb::Act.satisfied_by("act"));
        assert!(Verb::Act.satisfied_by("read+act"));
        assert!(!Verb::Act.satisfied_by("read"));
        // v0's `reveal` grant satisfies neither of the two a caller can ASK
        // for, which is what keeps it from widening a read.
        assert!(!Verb::Read.satisfied_by("reveal"));
        assert!(!Verb::Act.satisfied_by("reveal"));
    }

    #[test]
    fn a_read_only_device_is_denied_act_but_not_read() {
        let connection = memory();
        let principal = Principal::OwnerDevice {
            device_id: "widget".to_owned(),
            may_act: false,
            scope_clamp: None,
        };
        let decision = evaluate_access(&connection, &principal, "tally", "expense", Verb::Act)
            .expect("judged");
        match decision {
            Decision::Deny { failing, .. } => {
                assert!(failing.contains("read-only"), "{failing}");
                assert!(failing.contains("tally.expense"), "{failing}");
            }
            Decision::Allow { .. } => panic!("act must be denied"),
        }
        assert!(
            evaluate_access(&connection, &principal, "tally", "expense", Verb::Read)
                .expect("judged")
                .is_allow()
        );
    }

    #[test]
    fn an_unclamped_owner_is_allowed_owner_direct_with_no_filter() {
        let connection = memory();
        let decision = evaluate_access(
            &connection,
            &Principal::owner("phone"),
            "tally",
            "expense",
            Verb::Act,
        )
        .expect("judged");
        assert_eq!(
            decision,
            Decision::Allow {
                authority_id: None,
                row_filter: Vec::new(),
                field_mask: None,
            }
        );
    }

    #[test]
    fn a_clamp_with_no_covering_scope_denies_and_names_the_subject() {
        let connection = memory();
        let principal = Principal::OwnerDevice {
            device_id: "app".to_owned(),
            may_act: true,
            scope_clamp: Some(ScopeClamp {
                scopes: vec![scope("tally", "read", &[])],
            }),
        };
        match evaluate_access(&connection, &principal, "locker", "item", Verb::Read)
            .expect("judged")
        {
            Decision::Deny { failing, .. } => {
                assert!(failing.contains("locker.item"), "{failing}");
                assert!(failing.contains("declared reach"), "{failing}");
            }
            Decision::Allow { .. } => panic!("an app's reach is a ceiling"),
        }
        // And the verb is part of the cover: a `read` scope does not act.
        assert!(
            !evaluate_access(&connection, &principal, "tally", "expense", Verb::Act)
                .expect("judged")
                .is_allow()
        );
    }

    #[test]
    fn clamp_intersection_ands_filters_and_is_order_independent() {
        let wide = scope("tally", "read", &["a", "b", "c"]);
        let narrow = scope("tally", "read", &["b", "c"]);
        let one = intersect(&[&wide, &narrow]).expect("intersects");
        let other = intersect(&[&narrow, &wide]).expect("intersects");
        assert_eq!(one, other);
        assert_eq!(one.0[0].values, ["b", "c"]);
    }

    #[test]
    fn two_scopes_pinning_one_column_to_disjoint_sets_are_refused() {
        // NOT silently intersected to nothing: an empty screen reads as "no
        // data", and the truth is "these scopes contradict".
        let left = scope("tally", "read", &["a"]);
        let right = scope("tally", "read", &["b"]);
        let error = intersect(&[&left, &right]).expect_err("must refuse");
        assert!(error.to_string().contains("disjoint"), "{error}");
        assert!(error.to_string().contains("`in` filter"), "{error}");
    }

    #[test]
    fn masks_intersect_and_no_mask_is_every_column() {
        let mut left = scope("tally", "read", &[]);
        left.field_mask = Some(["a", "b", "c"].into_iter().map(str::to_owned).collect());
        let mut right = scope("tally", "read", &[]);
        right.field_mask = Some(["b", "c", "d"].into_iter().map(str::to_owned).collect());
        let open = scope("tally", "read", &[]);
        assert_eq!(
            intersect(&[&left, &right]).expect("intersects").1,
            Some(["b", "c"].into_iter().map(str::to_owned).collect())
        );
        // An unmasked scope does not WIDEN a masked one: it contributes no
        // ceiling of its own, and the masked one still applies.
        assert_eq!(
            intersect(&[&left, &open]).expect("intersects").1,
            Some(["a", "b", "c"].into_iter().map(str::to_owned).collect())
        );
        assert_eq!(intersect(&[&open]).expect("intersects").1, None);
    }

    // FOUR TESTS STOOD HERE AND THEIR CALLERS ARE DELETED (#1029 §1).
    //
    // `an_agent_cannot_exceed_the_owner_it_acts_for`,
    // `reveal_is_unreachable_through_a_standing_answer`,
    // `an_automation_needs_a_standing_answer_and_the_oldest_one_wins` and
    // `a_revoked_or_refused_grant_answers_nothing` all built a
    // `Principal::Agent` or a `Principal::Automation`. `crates/assist` and
    // `crates/automations` are gone, so nothing can construct either, and the
    // `share_authority` reader they exercised — the only consumer of
    // `principal_kind = 'automation'` — went with them.
    //
    // The property `reveal_is_unreachable_through_a_standing_answer` protected
    // is NOT lost: there is no reveal judgement, and no longer any path from
    // `share_authority` to a decision at all.
}
