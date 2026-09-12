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
//! 1. A read-only device asking to `act` or `reveal` is denied first, because
//!    the answer does not depend on anything else.
//! 2. An agent cannot exceed the owner it acts for. Checked before the clamp,
//!    so an agent with a generous clamp and a restricted owner is still capped.
//! 3. The execution clamp narrows **whoever holds it**, owner included. An app
//!    is the owner's own screen and holds no grant, but it does hold a declared
//!    reach, and that reach is a ceiling.
//! 4. An owner device with no clamp is allowed, with `authority_id: None` —
//!    owner-direct, and one id space since #928.
//! 5. **The assistant holds no standing answer.** It is allowed only while
//!    riding an acting owner who owns this vault; a standing grant to an
//!    assistant would be a grant to whatever is driving it.
//! 6. Everything else needs a `share_authority` row, and `reveal` is
//!    deliberately unreachable through one — a sealed reveal is Locker's
//!    permit, not an authority row.

use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::error::{Result, VaultError};

/// What is being asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verb {
    Read,
    Act,
    Reveal,
}

impl Verb {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Act => "act",
            Self::Reveal => "reveal",
        }
    }

    /// Does a granted verb satisfy a requested one?
    ///
    /// `read` is satisfied by `read` or `read+act`, `act` by `act` or
    /// `read+act`, and **`reveal` only by `reveal`** — never by the pair, and
    /// never by `act`. A reveal is the one verb that hands over plaintext.
    #[must_use]
    pub fn satisfied_by(self, granted: &str) -> bool {
        match self {
            Self::Read => matches!(granted, "read" | "read+act"),
            Self::Act => matches!(granted, "act" | "read+act"),
            Self::Reveal => granted == "reveal",
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
    /// The granted verb, in v0's spelling: `read`, `act`, `read+act`, `reveal`.
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
    /// An agent, always acting on behalf of an owner.
    Agent {
        agent_id: String,
        /// The owner whose authority caps this agent's.
        on_behalf_of: Box<Principal>,
        /// `true` for the built-in assistant, whose enrollment key is
        /// `_assistant` in v0 and which holds NO standing answer.
        assistant: bool,
        may_act: bool,
        scope_clamp: Option<ScopeClamp>,
    },
    /// An automation, identified by the manifest that compiled it.
    Automation {
        manifest_ref: String,
        scope_clamp: Option<ScopeClamp>,
    },
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
            Self::OwnerDevice { may_act, .. } | Self::Agent { may_act, .. } => *may_act,
            // An automation runs because the owner scheduled it; `act` is what
            // it is for. It is `reveal` that is unreachable for one.
            Self::Automation { .. } => true,
        }
    }

    #[must_use]
    pub const fn scope_clamp(&self) -> Option<&ScopeClamp> {
        match self {
            Self::OwnerDevice { scope_clamp, .. }
            | Self::Agent { scope_clamp, .. }
            | Self::Automation { scope_clamp, .. } => scope_clamp.as_ref(),
        }
    }

    /// The caller id that lands in `agent_command_invocation.caller_id`.
    #[must_use]
    pub fn caller_id(&self) -> &str {
        match self {
            Self::OwnerDevice { device_id, .. } => device_id,
            Self::Agent { agent_id, .. } => agent_id,
            Self::Automation { manifest_ref, .. } => manifest_ref,
        }
    }

    /// The provenance kind v0's `access_provenance` records.
    #[must_use]
    pub const fn provenance_kind(&self) -> &'static str {
        match self {
            Self::OwnerDevice { .. } => "owner",
            Self::Agent { .. } => "ai_agent",
            Self::Automation { .. } => "automation",
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
    let subject = format!("{schema}.{table}");

    // 1. A read-only surface cannot act or reveal.
    if matches!(verb, Verb::Act | Verb::Reveal) && !principal.may_act() {
        return Ok(Decision::Deny {
            failing: format!(
                "this device is read-only and cannot {} {subject}",
                verb.as_str()
            ),
            authority_id: None,
        });
    }

    // 2. AN AGENT CANNOT EXCEED THE OWNER IT ACTS FOR. Before the clamp, so a
    //    generous clamp on the agent cannot outrun a restricted owner.
    if let Principal::Agent { on_behalf_of, .. } = principal {
        let owner = evaluate_access(connection, on_behalf_of, schema, table, verb)?;
        if let Decision::Deny { failing, .. } = owner {
            return Ok(Decision::Deny {
                failing: format!("the owner this agent acts for cannot do it either: {failing}"),
                authority_id: None,
            });
        }
    }

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

    // 4. An owner device.
    if let Principal::OwnerDevice { .. } = principal {
        let (row_filter, field_mask) = clamped.unwrap_or_default();
        return Ok(Decision::Allow {
            authority_id: None,
            row_filter,
            field_mask,
        });
    }

    // 5. THE ASSISTANT HOLDS NO STANDING ANSWER. Allowed only while riding an
    //    acting owner, which step 2 already confirmed.
    if let Principal::Agent {
        assistant: true,
        on_behalf_of,
        ..
    } = principal
    {
        if !matches!(**on_behalf_of, Principal::OwnerDevice { .. }) {
            return Ok(Decision::Deny {
                failing: "the assistant holds no standing answer and is not riding an owner"
                    .to_owned(),
                authority_id: None,
            });
        }
        let (row_filter, field_mask) = clamped.unwrap_or_default();
        return Ok(Decision::Allow {
            authority_id: None,
            row_filter,
            field_mask,
        });
    }

    // A non-assistant agent riding an owner inherits the owner's answer,
    // narrowed by its own clamp. Step 2 proved the owner can.
    if let Principal::Agent {
        on_behalf_of,
        assistant: false,
        ..
    } = principal
        && matches!(**on_behalf_of, Principal::OwnerDevice { .. })
    {
        let (row_filter, field_mask) = clamped.unwrap_or_default();
        return Ok(Decision::Allow {
            authority_id: None,
            row_filter,
            field_mask,
        });
    }

    // 6. Everything else needs a standing answer.
    match standing_answer_id(connection, principal, schema, table, verb)? {
        Some(authority_id) => {
            let (row_filter, field_mask) = clamped.unwrap_or_default();
            Ok(Decision::Allow {
                authority_id: Some(authority_id),
                row_filter,
                field_mask,
            })
        }
        None => Ok(Decision::Deny {
            failing: format!("no standing answer grants {} on {subject}", verb.as_str()),
            authority_id: None,
        }),
    }
}

/// The `share_authority` row that answers, if one does.
///
/// `principal_kind = 'automation' AND decision = 'granted' AND revoked_at IS
/// NULL`, over a pack subject (`agent.pack` × schema) or an entity subject
/// (`core.entity` × `schema.table`), ordered `granted_at ASC, rowid ASC LIMIT 1`
/// — the OLDEST answer wins, so a later grant cannot silently widen an earlier
/// one's row filter.
///
/// **`reveal` is deliberately unreachable here.** A sealed reveal is Locker's
/// permit; an authority row that could grant one would be a second key custody.
fn standing_answer_id(
    connection: &Connection,
    principal: &Principal,
    schema: &str,
    table: &str,
    verb: Verb,
) -> Result<Option<String>> {
    if verb == Verb::Reveal {
        return Ok(None);
    }
    let Principal::Automation { manifest_ref, .. } = principal else {
        return Ok(None);
    };
    let subject = format!("{schema}.{table}");
    let mut statement = connection.prepare_cached(
        "SELECT authority_id, verb FROM share_authority
          WHERE principal_kind = 'automation'
            AND principal_id = ?1
            AND decision = 'granted'
            AND revoked_at IS NULL
            AND (
                  (subject_type = 'agent.pack' AND subject_id = ?2)
               OR (subject_type = 'core.entity' AND subject_id = ?3)
            )
          ORDER BY granted_at ASC, rowid ASC",
    )?;
    let rows: Vec<(String, String)> = statement
        .query_map(rusqlite::params![manifest_ref, schema, subject], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .find(|(_, granted)| verb.satisfied_by(granted))
        .map(|(id, _)| id))
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

    fn memory() -> Connection {
        let connection = Connection::open_in_memory().expect("memory opens");
        connection
            .execute_batch(
                "CREATE TABLE share_authority (
                   authority_id TEXT PRIMARY KEY, principal_kind TEXT, principal_id TEXT,
                   subject_type TEXT, subject_id TEXT, verb TEXT, decision TEXT,
                   granted_at TEXT, revoked_at TEXT)",
            )
            .expect("the stub table is made");
        connection
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
    fn the_verb_algebra_never_lets_act_satisfy_reveal() {
        assert!(Verb::Read.satisfied_by("read"));
        assert!(Verb::Read.satisfied_by("read+act"));
        assert!(!Verb::Read.satisfied_by("act"));
        assert!(Verb::Act.satisfied_by("act"));
        assert!(Verb::Act.satisfied_by("read+act"));
        assert!(!Verb::Act.satisfied_by("read"));
        assert!(Verb::Reveal.satisfied_by("reveal"));
        // THE ONE THAT MATTERS: nothing but `reveal` reveals.
        assert!(!Verb::Reveal.satisfied_by("read+act"));
        assert!(!Verb::Reveal.satisfied_by("act"));
        assert!(!Verb::Reveal.satisfied_by("read"));
    }

    #[test]
    fn a_read_only_device_is_denied_act_and_reveal_but_not_read() {
        let connection = memory();
        let principal = Principal::OwnerDevice {
            device_id: "widget".to_owned(),
            may_act: false,
            scope_clamp: None,
        };
        for verb in [Verb::Act, Verb::Reveal] {
            let decision =
                evaluate_access(&connection, &principal, "tally", "expense", verb).expect("judged");
            match decision {
                Decision::Deny { failing, .. } => {
                    assert!(failing.contains("read-only"), "{failing}");
                    assert!(failing.contains("tally.expense"), "{failing}");
                }
                Decision::Allow { .. } => panic!("{verb:?} must be denied"),
            }
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

    #[test]
    fn an_agent_cannot_exceed_the_owner_it_acts_for() {
        let connection = memory();
        let read_only_owner = Principal::OwnerDevice {
            device_id: "widget".to_owned(),
            may_act: false,
            scope_clamp: None,
        };
        let agent = Principal::Agent {
            agent_id: "helper".to_owned(),
            on_behalf_of: Box::new(read_only_owner),
            assistant: false,
            may_act: true,
            scope_clamp: None,
        };
        match evaluate_access(&connection, &agent, "tally", "expense", Verb::Act).expect("judged") {
            Decision::Deny { failing, .. } => {
                assert!(failing.contains("acts for"), "{failing}");
            }
            Decision::Allow { .. } => panic!("the owner's cap is the agent's cap"),
        }
    }

    #[test]
    fn reveal_is_unreachable_through_a_standing_answer() {
        let connection = memory();
        connection
            .execute(
                "INSERT INTO share_authority VALUES
                   ('auth-1','automation','manifest-1','agent.pack','tally','reveal','granted','2026-01-01T00:00:00.000Z',NULL)",
                [],
            )
            .expect("the grant inserts");
        let automation = Principal::Automation {
            manifest_ref: "manifest-1".to_owned(),
            scope_clamp: None,
        };
        // A row that says `reveal` in the table does not produce one.
        assert!(
            !evaluate_access(&connection, &automation, "tally", "expense", Verb::Reveal)
                .expect("judged")
                .is_allow()
        );
    }

    #[test]
    fn an_automation_needs_a_standing_answer_and_the_oldest_one_wins() {
        let connection = memory();
        connection
            .execute_batch(
                "INSERT INTO share_authority VALUES
                   ('auth-late','automation','m','agent.pack','tally','read+act','granted','2026-02-01T00:00:00.000Z',NULL),
                   ('auth-early','automation','m','agent.pack','tally','read','granted','2026-01-01T00:00:00.000Z',NULL);",
            )
            .expect("the grants insert");
        let automation = Principal::Automation {
            manifest_ref: "m".to_owned(),
            scope_clamp: None,
        };
        match evaluate_access(&connection, &automation, "tally", "expense", Verb::Read)
            .expect("judged")
        {
            Decision::Allow { authority_id, .. } => {
                assert_eq!(authority_id.as_deref(), Some("auth-early"));
            }
            Decision::Deny { failing, .. } => panic!("{failing}"),
        }
        // `act` is not satisfied by the early `read` row, so the later
        // `read+act` one answers — the ordering picks the oldest row that
        // ACTUALLY satisfies the verb, not the oldest row full stop.
        match evaluate_access(&connection, &automation, "tally", "expense", Verb::Act)
            .expect("judged")
        {
            Decision::Allow { authority_id, .. } => {
                assert_eq!(authority_id.as_deref(), Some("auth-late"));
            }
            Decision::Deny { failing, .. } => panic!("{failing}"),
        }
    }

    #[test]
    fn a_revoked_or_refused_grant_answers_nothing() {
        let connection = memory();
        connection
            .execute_batch(
                "INSERT INTO share_authority VALUES
                   ('auth-revoked','automation','m','agent.pack','tally','read','granted','2026-01-01T00:00:00.000Z','2026-03-01T00:00:00.000Z'),
                   ('auth-refused','automation','m','agent.pack','tally','read','refused','2026-01-01T00:00:00.000Z',NULL);",
            )
            .expect("the grants insert");
        let automation = Principal::Automation {
            manifest_ref: "m".to_owned(),
            scope_clamp: None,
        };
        assert!(
            !evaluate_access(&connection, &automation, "tally", "expense", Verb::Read)
                .expect("judged")
                .is_allow()
        );
    }
}
