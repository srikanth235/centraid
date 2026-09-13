//! The proto boundary: lane C's generated types on one side, D1's and D2's
//! plain Rust on the other.
//!
//! **The conversion lives here and nowhere else.** `crates/vault` deliberately
//! does not depend on `crates/api-proto` (lane C wrote the schema concurrently
//! with lane D1's file), and `crates/seat` does not either. So this module is
//! the single seam, and a spelling that drifts drifts in one file.
//!
//! ## The one asymmetry worth naming
//!
//! `Value` on the wire carries the whole `i64` range as `int64`, with **no
//! decimal-text escape**. The vault's own JSON encoding has one — `{"i": "…"}`
//! past `Number.MAX_SAFE_INTEGER` — because that encoding is v0's and lives
//! *inside the file*, where a JS reader must still be able to read it. Protobuf
//! has real 64-bit integers, so the wire needs no escape and must not invent
//! one: a seat that received `{"i"}` on the wire would be parsing JSON out of a
//! protobuf field.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::log::{LogOp, LogPage, LogRow};
use centraid_vault::value::{RowImage, Value};

use crate::error::{CoreError, Result};

/// A vault value as the wire spells it.
#[must_use]
pub fn value_to_wire(value: &Value) -> wire::Value {
    wire::Value {
        kind: Some(match value {
            Value::Null => wire::value::Kind::Null(wire::NullValue {}),
            Value::Text(text) => wire::value::Kind::Text(text.clone()),
            // THE WHOLE i64 RANGE. No decimal-text escape: that is the file's
            // encoding, not the wire's.
            Value::Integer(int) => wire::value::Kind::Integer(*int),
            Value::Real(real) => wire::value::Kind::Real(*real),
            Value::Blob(bytes) => wire::value::Kind::Blob(bytes.clone()),
        }),
    }
}

/// A wire value as the vault holds it.
///
/// An absent `kind` is refused rather than read as NULL: proto3 cannot say
/// "required", so the refusal is the contract. A peer that sent no kind meant
/// something this build cannot know, and NULL is a guess that writes over data.
pub fn value_from_wire(value: &wire::Value) -> Result<Value> {
    let Some(kind) = &value.kind else {
        return Err(CoreError::InvalidRequest {
            detail: "a Value carries no kind; an absent kind is not SQL NULL".to_owned(),
        });
    };
    Ok(match kind {
        wire::value::Kind::Null(_) => Value::Null,
        wire::value::Kind::Text(text) => Value::Text(text.clone()),
        wire::value::Kind::Integer(int) => Value::Integer(*int),
        wire::value::Kind::Real(real) => Value::Real(*real),
        wire::value::Kind::Blob(bytes) => Value::Blob(bytes.to_vec()),
    })
}

/// A primary key as the wire spells it.
#[must_use]
pub fn key_to_wire(key: &[Value]) -> wire::RecordKey {
    wire::RecordKey {
        values: key.iter().map(value_to_wire).collect(),
    }
}

/// A row image as the wire spells it.
#[must_use]
pub fn image_to_wire(image: &RowImage) -> wire::RowImage {
    wire::RowImage {
        columns: image
            .iter()
            .map(|(column, value)| (column.clone(), value_to_wire(value)))
            .collect(),
    }
}

/// A prior delta as the wire spells it.
///
/// Separate from [`image_to_wire`] because the two are different claims with
/// the same shape: an image is a whole row and a delta is the touched columns'
/// OLD values. `PriorDelta` being its own message is what keeps a consumer from
/// treating one as the other.
#[must_use]
pub fn prior_to_wire(prior: &RowImage) -> wire::PriorDelta {
    wire::PriorDelta {
        columns: prior
            .iter()
            .map(|(column, value)| (column.clone(), value_to_wire(value)))
            .collect(),
    }
}

/// A row image read back off the wire.
pub fn image_from_wire(image: &wire::RowImage) -> Result<RowImage> {
    let mut out = RowImage::new();
    for (column, value) in &image.columns {
        out.insert(column.clone(), value_from_wire(value)?);
    }
    Ok(out)
}

/// A log op as the wire spells it.
#[must_use]
pub const fn op_to_wire(op: LogOp) -> wire::LogOp {
    match op {
        LogOp::Insert => wire::LogOp::Insert,
        LogOp::Update => wire::LogOp::Update,
        LogOp::Delete => wire::LogOp::Delete,
        LogOp::Ddl => wire::LogOp::Ddl,
    }
}

/// A log op read back. `UNSPECIFIED` is refused: a row whose op this build does
/// not know must not be applied as an insert.
pub fn op_from_wire(op: i32) -> Result<LogOp> {
    Ok(match wire::LogOp::try_from(op) {
        Ok(wire::LogOp::Insert) => LogOp::Insert,
        Ok(wire::LogOp::Update) => LogOp::Update,
        Ok(wire::LogOp::Delete) => LogOp::Delete,
        Ok(wire::LogOp::Ddl) => LogOp::Ddl,
        Ok(wire::LogOp::Unspecified) | Err(_) => {
            return Err(CoreError::InvalidRequest {
                detail: format!("`{op}` is not a log op this build knows"),
            });
        }
    })
}

/// One log row as the wire spells it.
///
/// `local` does not cross: a local row is captured for the doorbell and **never
/// served**, so a wire field for it would be a field that is always false and
/// an invitation to serve one.
#[must_use]
pub fn log_row_to_wire(row: &LogRow) -> wire::LogRow {
    wire::LogRow {
        seq: row.seq.unsigned_abs(),
        commit_seq: row.commit_seq.unsigned_abs(),
        schema_epoch: u32::try_from(row.schema_epoch).unwrap_or(0),
        ddl_version: u32::try_from(row.ddl_version).unwrap_or(0),
        table: row.table.clone(),
        op: op_to_wire(row.op) as i32,
        pk: Some(key_to_wire(&row.primary_key)),
        row: row.row.as_ref().map(image_to_wire),
        // ABSENT means "no prior is known"; PRESENT AND EMPTY means "the
        // statement touched only the key". `optional` is what keeps those two
        // apart, and collapsing them is the claim that forces a re-bootstrap.
        prior: row.prior.as_ref().map(prior_to_wire),
        indirect: row.indirect,
        deferred: row.deferred,
        producer: row.producer.clone(),
        committed_at: row.committed_at.clone(),
    }
}

/// One log row read back.
pub fn log_row_from_wire(row: &wire::LogRow, epoch: &str) -> Result<LogRow> {
    let op = op_from_wire(row.op)?;
    Ok(LogRow {
        seq: i64::try_from(row.seq).unwrap_or(i64::MAX),
        commit_seq: i64::try_from(row.commit_seq).unwrap_or(i64::MAX),
        // The epoch rides ONCE PER PAGE, not per row, so it is stamped from the
        // page header here. The applier then checks every row against the
        // FILE's epoch, which is the gate the header cannot be trusted for.
        epoch: epoch.to_owned(),
        schema_epoch: i64::from(row.schema_epoch),
        ddl_version: i64::from(row.ddl_version),
        table: row.table.clone(),
        op,
        primary_key: row
            .pk
            .as_ref()
            .map(|key| key.values.iter().map(value_from_wire).collect())
            .transpose()?
            .unwrap_or_default(),
        row: row.row.as_ref().map(image_from_wire).transpose()?,
        prior: row
            .prior
            .as_ref()
            .map(|prior| {
                let mut out = RowImage::new();
                for (column, value) in &prior.columns {
                    out.insert(column.clone(), value_from_wire(value)?);
                }
                Ok::<_, CoreError>(out)
            })
            .transpose()?,
        indirect: row.indirect,
        producer: row.producer.clone(),
        deferred: row.deferred,
        // A served row is never local, by construction: the door filters them.
        local: false,
        committed_at: row.committed_at.clone(),
    })
}

/// A whole page as the wire spells it.
#[must_use]
pub fn log_page_to_wire(page: &LogPage, vault_id: &str) -> wire::LogPage {
    wire::LogPage {
        vault_id: vault_id.to_owned(),
        epoch: page.vault_epoch.clone(),
        schema_epoch: u32::try_from(page.schema_epoch).unwrap_or(0),
        ddl_version: u32::try_from(page.ddl_version).unwrap_or(0),
        floor: page.floor.seq.unsigned_abs(),
        watermark: page.watermark.seq.unsigned_abs(),
        next: page.next.seq.unsigned_abs(),
        has_more: page.has_more,
        rows: page.rows.iter().map(log_row_to_wire).collect(),
    }
}

/// A re-bootstrap reason as the wire spells it.
#[must_use]
pub const fn rebootstrap_to_wire(
    reason: centraid_vault::RebootstrapReason,
) -> wire::RebootstrapReason {
    use centraid_vault::RebootstrapReason as R;
    match reason {
        R::EpochMismatch => wire::RebootstrapReason::EpochMismatch,
        R::Retention => wire::RebootstrapReason::Retention,
        R::CursorAhead => wire::RebootstrapReason::CursorAhead,
        R::Initial => wire::RebootstrapReason::Initial,
        R::InvalidCursor => wire::RebootstrapReason::InvalidCursor,
    }
}

/// A principal off the wire.
///
/// **Never inferred from the connection inside the core.** The gateway resolves
/// the enrolled device to a principal at the ALPN boundary and stamps it on the
/// request; every authority decision downstream reads that field. A core that
/// derived the principal from its own socket would be a core that cannot be
/// asked "what would this OTHER caller be allowed", which is what a thin seat's
/// forwarding needs.
pub fn principal_from_wire(
    principal: Option<&wire::Principal>,
) -> Result<centraid_vault::Principal> {
    let Some(principal) = principal else {
        return Err(CoreError::InvalidRequest {
            detail: "a command carries no principal; the core never infers one".to_owned(),
        });
    };
    match wire::PrincipalKind::try_from(principal.kind) {
        Ok(wire::PrincipalKind::OwnerDevice) => Ok(centraid_vault::Principal::owner(
            if principal.surface.is_empty() {
                principal.caller_id.clone()
            } else {
                // A NAMED SURFACE becomes the caller id, as v0's `identity.ts`
                // does: the surface is what the receipt should name, because
                // "the Money screen asked" is the fact a member can audit and
                // "device 4f2a" is not.
                principal.surface.clone()
            },
        )),
        Ok(wire::PrincipalKind::Agent) => {
            if !principal.on_behalf_of_owner {
                // AN AGENT ALWAYS RIDES AN OWNER. The assistant holds no
                // standing answer of its own, and an agent can never exceed
                // the owner it rides — so an agent with no owner to ride is
                // not an agent with less authority, it is a request the
                // authority plane cannot evaluate.
                return Err(CoreError::InvalidRequest {
                    detail: "an agent principal must ride an acting owner".to_owned(),
                });
            }
            Ok(centraid_vault::Principal::Agent {
                agent_id: principal.caller_id.clone(),
                on_behalf_of: Box::new(centraid_vault::Principal::owner(
                    principal.principal_id.clone(),
                )),
                // v0's marker: the built-in assistant's enrollment key.
                assistant: principal.principal_id == "_assistant",
                may_act: true,
                scope_clamp: None,
            })
        }
        Ok(wire::PrincipalKind::Unspecified) | Err(_) => Err(CoreError::InvalidRequest {
            detail: format!("`{}` is not a principal kind", principal.kind),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_value_kind_round_trips() {
        for value in [
            Value::Null,
            Value::Text("a".to_owned()),
            Value::Integer(i64::MIN),
            Value::Integer(i64::MAX),
            Value::Real(1.5),
            Value::Blob(vec![0, 1, 255]),
        ] {
            let round = value_from_wire(&value_to_wire(&value)).expect("it reads back");
            assert_eq!(round, value, "`{value:?}` did not survive");
        }
    }

    /// The asymmetry, stated as a test. Past `Number.MAX_SAFE_INTEGER` the
    /// FILE's encoding escapes to decimal text; the WIRE does not.
    #[test]
    fn a_wide_integer_crosses_the_wire_as_an_integer_and_not_as_decimal_text() {
        let wide = Value::Integer(centraid_vault::value::MAX_SAFE_INTEGER + 1);
        let on_the_wire = value_to_wire(&wide);
        assert!(matches!(
            on_the_wire.kind,
            Some(wire::value::Kind::Integer(_))
        ));
        // And the file's own encoding does escape, which is why this test
        // exists rather than being obvious.
        assert!(wide.to_wire_json().contains("\"i\""));
    }

    #[test]
    fn an_absent_value_kind_is_refused_and_not_read_as_null() {
        assert!(value_from_wire(&wire::Value { kind: None }).is_err());
    }

    #[test]
    fn an_absent_prior_and_an_empty_prior_stay_apart() {
        let base = LogRow {
            seq: 1,
            commit_seq: 1,
            epoch: "e".to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            table: "t".to_owned(),
            op: LogOp::Update,
            primary_key: vec![Value::Text("k".to_owned())],
            row: Some(RowImage::new()),
            prior: None,
            indirect: false,
            producer: "p".to_owned(),
            deferred: false,
            local: false,
            committed_at: "t".to_owned(),
        };
        assert!(
            log_row_to_wire(&base).prior.is_none(),
            "absent stays absent"
        );

        let mut touched_only_the_key = base.clone();
        touched_only_the_key.prior = Some(RowImage::new());
        let wired = log_row_to_wire(&touched_only_the_key);
        assert!(
            wired.prior.is_some(),
            "present-and-empty is a REAL ANSWER and must not collapse to absent"
        );
        assert!(wired.prior.expect("present").columns.is_empty());
    }

    #[test]
    fn a_row_read_back_takes_its_epoch_from_the_page_header() {
        let row = wire::LogRow {
            seq: 5,
            commit_seq: 2,
            schema_epoch: 4,
            ddl_version: 0,
            table: "t".to_owned(),
            op: wire::LogOp::Insert as i32,
            pk: Some(key_to_wire(&[Value::Text("k".to_owned())])),
            row: None,
            prior: None,
            indirect: false,
            deferred: false,
            producer: "p".to_owned(),
            committed_at: "t".to_owned(),
        };
        let read = log_row_from_wire(&row, "the-page-epoch").expect("it reads");
        assert_eq!(read.epoch, "the-page-epoch");
        // And a served row is never local, by construction.
        assert!(!read.local);
    }

    #[test]
    fn an_unknown_log_op_is_refused_and_not_applied_as_an_insert() {
        assert!(op_from_wire(wire::LogOp::Unspecified as i32).is_err());
        assert!(op_from_wire(99).is_err());
        assert_eq!(
            op_from_wire(wire::LogOp::Delete as i32).expect("known"),
            LogOp::Delete
        );
    }

    #[test]
    fn a_named_surface_becomes_the_caller_id() {
        let principal = wire::Principal {
            kind: wire::PrincipalKind::OwnerDevice as i32,
            caller_id: "device-4f2a".to_owned(),
            principal_id: String::new(),
            surface: "money".to_owned(),
            on_behalf_of_owner: false,
        };
        let read = principal_from_wire(Some(&principal)).expect("it reads");
        assert_eq!(read.caller_id(), "money");
    }

    #[test]
    fn a_command_with_no_principal_is_refused_rather_than_given_one() {
        assert!(principal_from_wire(None).is_err());
        assert!(
            principal_from_wire(Some(&wire::Principal {
                kind: wire::PrincipalKind::Unspecified as i32,
                caller_id: "x".to_owned(),
                principal_id: String::new(),
                surface: String::new(),
                on_behalf_of_owner: false,
            }))
            .is_err()
        );
    }

    #[test]
    fn every_rebootstrap_reason_has_a_wire_value_that_is_not_unspecified() {
        for reason in [
            centraid_vault::RebootstrapReason::EpochMismatch,
            centraid_vault::RebootstrapReason::Retention,
            centraid_vault::RebootstrapReason::CursorAhead,
            centraid_vault::RebootstrapReason::Initial,
            centraid_vault::RebootstrapReason::InvalidCursor,
        ] {
            assert_ne!(
                rebootstrap_to_wire(reason),
                wire::RebootstrapReason::Unspecified,
                "`{reason}` has no wire value"
            );
        }
    }
}
