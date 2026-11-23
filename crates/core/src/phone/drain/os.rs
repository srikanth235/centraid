//! Operating system background upload hand-off, settlement, and reconciliation (iOS URLSession).

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::backup::mover;
use centraid_vault::backup::naming::Name;
use centraid_vault::backup::state::{DeviceState, Gateway};
use centraid_vault::backup::store::{Refusal, StoreError};
use centraid_vault::clock::SystemClock;

use super::policy::{Conditions, Kind, allows_cellular};
use super::{HANDOFF_GRACE_MS, mark_token_refused};
use crate::error::{CoreError, Result};
use crate::phone::link::{self, GatewayStore};
use crate::phone::{Keyring, Plane, now_ms, plane_error};

// ─── the operating system's half ────────────────────────────────────────────

/// **Hand sealed parts to the operating system** (`handoff`, #1080 ruling 2).
///
/// A batch of queued parts nobody is moving, in queue order, each as a
/// presigned `PUT` to the gateway this phone reached last, and each marked
/// handed off. A video's original is left out when the member left videos
/// out; every other part goes, with `allows_cellular` saying whether the
/// operating system may move it over a metered link.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a zero limit; [`CoreError::VaultMoved`]
/// for a phone a gateway superseded; the ledger's refusal.
pub fn handoff(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::HandoffRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::HandoffResponse> {
    if request.max_bytes == 0 || request.max_parts == 0 {
        return Err(CoreError::InvalidRequest {
            detail: "a handoff names both limits; a zero is never read as \"no limit\"".to_owned(),
        });
    }
    let state = plane.state()?;
    if let Some(epoch) = crate::phone::superseded_everywhere(&state)? {
        return Err(CoreError::VaultMoved {
            current_epoch: epoch,
            moved_at_ms: 0,
        });
    }
    // EACH PART GOES TO THE GATEWAY ITS ROW NAMES (#1188, B1), the one reached last first:
    // the one `reconcile` just answered from.
    let mut ordered: Vec<(usize, Gateway)> = state
        .gateways()
        .map_err(plane_error)?
        .into_iter()
        .enumerate()
        .collect();
    ordered
        .sort_by_key(|(order, gateway)| (std::cmp::Reverse(gateway.seen_ms.unwrap_or(0)), *order));
    if ordered.is_empty() {
        return Ok(wire::HandoffResponse { parts: Vec::new() });
    }
    let conditions = Conditions::remembered(plane);
    let tokens = plane.tokens();
    let mut stores: BTreeMap<String, GatewayStore> = BTreeMap::new();
    let vault_hex = keyring.vault_hex();
    let max_parts = usize::try_from(request.max_parts).unwrap_or(usize::MAX);
    let mut parts = Vec::new();
    let mut bytes = 0_u64;
    'gateways: for (_, target) in &ordered {
        // A GATEWAY THIS PHONE WAS SUPERSEDED AT, or holds no token for, is not fed.
        if target.moved_epoch.is_some() {
            continue;
        }
        let Some(token) = tokens.get(&target.gateway_id) else {
            continue;
        };
        for part in state.outbox(&target.gateway_id).map_err(plane_error)? {
            if parts.len() >= max_parts {
                break 'gateways;
            }
            let (Some(path), Some(size), Some(digest)) =
                (part.part_path.as_ref(), part.size, part.digest.as_ref())
            else {
                continue;
            };
            let kind = Kind::of_part(&part);
            if part.handed_ms.is_some() || !conditions.counts(kind) {
                continue;
            }
            if bytes.saturating_add(size) > request.max_bytes {
                break 'gateways;
            }
            if !stores.contains_key(&target.gateway_id) {
                stores.insert(
                    target.gateway_id.clone(),
                    GatewayStore::for_gateway(
                        target,
                        *token,
                        keyring.vault.identity.signing(),
                        runtime,
                    )?,
                );
            }
            let store = &stores[&target.gateway_id];
            let presigned = store
                .client()
                .presign_put(
                    store.vault(),
                    &link::wire_name(&part.name),
                    &centraid_gateway::rules::ids::Digest::from_bytes(*digest.as_bytes()),
                    size,
                )
                .map_err(|error| CoreError::Invariant {
                    context: format!("presigning a part: {error}"),
                })?;
            state
                .hand_off(&target.gateway_id, &part.name, now_ms())
                .map_err(plane_error)?;
            bytes = bytes.saturating_add(size);
            parts.push(wire::HandoffPart {
                name: part.name.to_hex(),
                path: path.to_string_lossy().into_owned(),
                url: presigned.url,
                method: presigned.method,
                headers: presigned
                    .headers
                    .into_iter()
                    .map(|(name, value)| wire::Header { name, value })
                    .collect(),
                size,
                gateway_id: target.gateway_id.clone(),
                vault_id: vault_hex.clone(),
                allows_cellular: allows_cellular(kind, conditions.rule),
            });
        }
    }
    Ok(wire::HandoffResponse { parts })
}

/// **Record what the operating system reported** (`settle`, #1080 ruling 7).
///
/// A `2xx` is the gateway's acknowledgement, and so is `NAME_TAKEN` (the same
/// bytes sealed again, R-1080-B4): the row goes and the file leaves the spool once no gateway
/// owes it. `DIGEST_MISMATCH` is a torn spool file: the row is unsealed to be sealed again.
/// Anything else, `MOVED` included (a report the operating system carried is not a claim the
/// vault key signed, E4), puts the part back to be moved. A name the outbox does not hold, or a
/// part for another vault, is ignored and not counted (the root's ruling A6).
///
/// # Errors
/// The device state's or the spool's refusal.
pub fn settle(
    plane: &Plane,
    keyring: &Keyring,
    request: &wire::SettleRequest,
) -> Result<wire::SettleResponse> {
    let state = plane.state()?;
    let spool = plane.spool()?;
    let mine = keyring.vault_hex();
    let mut answer = wire::SettleResponse::default();
    let mut files_confirmed = false;
    for settled in &request.settled {
        if !settled.vault_id.is_empty() && settled.vault_id != mine {
            continue;
        }
        let Ok(name) = Name::from_hex(&settled.name) else {
            continue;
        };
        let Some(part) = state
            .outbox_row(&settled.gateway_id, &name)
            .map_err(plane_error)?
        else {
            continue;
        };
        // THE OPERATING SYSTEM WAS TOLD NO BY A GATEWAY THAT DOES NOT KNOW
        // THIS PHONE'S TOKEN (the sweep's F2): marked as a pass would mark it,
        // so the status says to pair again whichever half met the refusal.
        if settled.http_status == 401 || settled.error == "UNAUTHORIZED" {
            mark_token_refused(&state, &settled.gateway_id)?;
        }
        let acknowledged = matches!(settled.http_status, 200 | 201)
            || (settled.http_status == 409 && settled.error == "NAME_TAKEN");
        if acknowledged {
            mover::release_many(&state, &spool, &settled.gateway_id, &[name], true)
                .map_err(plane_error)?;
            state
                .touch_ack(&settled.gateway_id, now_ms())
                .map_err(plane_error)?;
            answer.confirmed += 1;
            files_confirmed |= Kind::of_part(&part) != Kind::Records;
        } else if settled.error == "DIGEST_MISMATCH" {
            state
                .unseal(&settled.gateway_id, &name, "DIGEST_MISMATCH")
                .map_err(plane_error)?;
            spool.remove(&name).map_err(plane_error)?;
            answer.requeued += 1;
        } else {
            // ANY OTHER OUTCOME: the part goes back to waiting.
            let reason = if settled.error.is_empty() {
                format!("HTTP_{}", settled.http_status)
            } else {
                settled.error.clone()
            };
            requeue(&state, &settled.gateway_id, &name, &reason)?;
            answer.requeued += 1;
        }
    }
    // FILES THE OPERATING SYSTEM CONFIRMED ARE FILES A PASS DID NOT (R-1080-C15):
    // their rows are in no snapshot yet, so the next pass that may carry the
    // records takes one first, as it does for a pass that was cut off.
    if files_confirmed {
        plane.set_snapshot_owed(true);
    }
    Ok(answer)
}

/// A part the operating system did not finish is the phone's to move again.
fn requeue(state: &DeviceState, gateway_id: &str, name: &Name, reason: &str) -> Result<()> {
    state
        .record_attempt(gateway_id, name, reason)
        .map_err(plane_error)?;
    state.unhand_many(gateway_id, &[*name]).map_err(plane_error)
}

/// **Square the outbox with what a gateway holds** (`reconcile`, #1080
/// ruling 7), at the first paired gateway that answers.
///
/// Every owed name the gateway already holds is let go and leaves the spool (an outbox is all
/// there is to ask about now, so `full` and not are the same question). A part handed to the
/// operating system longer ago than [`HANDOFF_GRACE_MS`] that the gateway does not hold goes
/// back to be moved.
///
/// # Errors
/// The device state's or the spool's refusal. A gateway that stops answering
/// mid-way is `reachable: false`, never an error.
pub fn reconcile(
    plane: &Plane,
    keyring: &Keyring,
    runtime: &tokio::runtime::Handle,
    _full: bool,
) -> Result<wire::ReconcileResponse> {
    let state = plane.state()?;
    let spool = plane.spool()?;
    let unreachable = wire::ReconcileResponse {
        confirmed: 0,
        requeued: 0,
        reachable: false,
    };
    if crate::phone::superseded_everywhere(&state)?.is_some() {
        return Ok(unreachable);
    }
    let gateways = state.gateways().map_err(plane_error)?;
    let Ok(reached) = link::reach(
        &gateways,
        &state,
        &plane.tokens(),
        keyring.vault.identity.signing(),
        runtime,
    )?
    else {
        return Ok(unreachable);
    };
    let reconciled = mover::reconcile(&state, &spool, &reached.store, &SystemClock);
    let reconciled = match reconciled {
        Ok(reconciled) => reconciled,
        Err(centraid_vault::backup::PlaneError::Store(error)) => {
            tracing::debug!(%error, "the gateway stopped answering mid-reconcile");
            if matches!(error, StoreError::Refused(Refusal::Unauthorized)) {
                mark_token_refused(&state, &reached.gateway.gateway_id)?;
            }
            return Ok(unreachable);
        }
        Err(other) => return Err(plane_error(other)),
    };
    // NAMES THE GATEWAY HELD ARE FILES CONFIRMED OUTSIDE A PASS (R-1080-C15).
    if !reconciled.confirmed.is_empty() {
        plane.set_snapshot_owed(true);
    }
    let now = now_ms();
    let mut requeued = 0_u32;
    for gateway in &gateways {
        for part in state.outbox(&gateway.gateway_id).map_err(plane_error)? {
            if part
                .handed_ms
                .is_some_and(|at| now.saturating_sub(at) > HANDOFF_GRACE_MS)
            {
                requeue(&state, &gateway.gateway_id, &part.name, "LOST")?;
                requeued += 1;
            }
        }
    }
    Ok(wire::ReconcileResponse {
        confirmed: u32::try_from(reconciled.confirmed.len()).unwrap_or(u32::MAX),
        requeued,
        reachable: true,
    })
}
