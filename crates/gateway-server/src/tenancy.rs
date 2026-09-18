//! ADMISSION: A HOUSEHOLD, PER-PERSON VAULTS, AND AN INVITE (Q13, #1029 §3).
//!
//! Admission is one of the two things the two deployments genuinely do
//! differently — the hosted adapter admits by purchase, this one by an invite
//! the server's owner minted — and it is the *only* thing about tenancy that
//! differs. `centraid-gateway-core` is multi-tenant already: every rule is
//! written over a `VaultId`, every statement in
//! `contracts/gateway/queries/` names `vault_key` in its predicate, and a
//! quota is a `Plan` on the account a vault hangs off. So there is no
//! "multi-tenant mode" here and there is not going to be one; what is here is
//! how a second person gets a vault at all.
//!
//! # WHY AN INVITE AND NOT A SIGN-UP
//!
//! A gateway is addressed by a vault's identity key and a stranger and an
//! unregistered vault get the same refusal, so an open registration endpoint
//! would be an unbounded free tier on somebody's home box: keys are free to
//! mint (F13). The owner mints an invite, hands it over out of band — reading
//! it aloud at a kitchen table is the design centre — and the phone presents it
//! once. After redemption the invite is spent and the vault is an ordinary
//! tenant that every rule already knows how to judge.
//!
//! # THE SERVER HOLDS THE INVITE'S HASH, NEVER THE INVITE
//!
//! An invite is a bearer secret. `contracts/gateway/standalone.sql` stores its
//! BLAKE3 so that a stolen state file is not a set of working invitations, and
//! redemption is a conditional `UPDATE` on `redeemed_at_ms IS NULL` so two
//! phones racing on one invite end with one vault rather than two.
//!
//! And the gateway is still blind: there is no member name, no email address
//! and no label anywhere in this module, because there is no column for one.

use centraid_gateway_core::ids::{AccountId, Key32, VaultId};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::store::StoreFault;
use centraid_gateway_core::time::ServerTime;
use rand::RngCore as _;
use rusqlite::{OptionalExtension, params};

use crate::sql;
use crate::state::{self, SqliteState};

/// How long an unredeemed invite stays good.
///
/// Thirty days. Long enough that "I will set it up at the weekend" works;
/// short enough that an invite read aloud a year ago is not a standing
/// credential on a household's server.
pub const INVITE_LIFETIME_MS: i64 = 30 * 86_400_000;

/// An invite as the owner sees it once, and never again.
#[derive(Debug, Clone)]
pub struct Invite {
    /// The secret, base32-ish hex the owner reads out. **Only ever returned
    /// from [`mint`]**; the server keeps its hash.
    pub code: String,
    pub quota_bytes: u64,
    pub expires_at: ServerTime,
}

/// One invite's standing, for the owner's listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteRecord {
    pub code_hash: [u8; 32],
    pub quota_bytes: u64,
    pub created_at: ServerTime,
    pub expires_at: ServerTime,
    pub redeemed_at: Option<ServerTime>,
    pub redeemed_by: Option<AccountId>,
}

/// Why a redemption was refused.
///
/// **Every arm is the same answer to a stranger.** An invite that never
/// existed, one that expired and one somebody else already used are
/// distinguishable to the owner reading a log and are one refusal on the wire:
/// a gateway that told a caller "that invite exists but is spent" would be an
/// oracle for which invites a household has minted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InviteRefusal {
    #[error("gateway: invite")]
    Unknown,
    #[error("gateway: invite")]
    Expired,
    #[error("gateway: invite")]
    AlreadyRedeemed,
}

/// The BLAKE3 of an invite code. One hash (#1025 S4).
#[must_use]
pub fn code_hash(code: &str) -> [u8; 32] {
    *blake3::hash(code.trim().as_bytes()).as_bytes()
}

/// Mint an invite the owner can read aloud.
///
/// # Errors
///
/// A store fault.
pub fn mint(store: &SqliteState, quota_bytes: u64, now: ServerTime) -> Result<Invite, StoreFault> {
    // 160 bits from the platform's generator. Randomness is the ADAPTER's here
    // exactly as it is in a Worker: `gateway-core` takes anything random as an
    // input, and this is where the input comes from.
    let mut secret = [0_u8; 20];
    rand::rng().fill_bytes(&mut secret);
    let code = group(&hex::encode(secret));
    let expires_at = ServerTime::from_millis(now.millis().saturating_add(INVITE_LIFETIME_MS));
    store
        .connection()?
        .execute(
            sql::INVITE_INSERT,
            params![
                code_hash(&code).as_slice(),
                i64::try_from(quota_bytes).unwrap_or(i64::MAX),
                now.millis(),
                expires_at.millis(),
            ],
        )
        .map_err(|error| StoreFault::new(error.to_string()))?;
    Ok(Invite {
        code,
        quota_bytes,
        expires_at,
    })
}

/// `aaaa-bbbb-…`, so somebody can read it over a kitchen table without losing
/// their place.
fn group(hex: &str) -> String {
    hex.as_bytes()
        .chunks(4)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// Redeem an invite and register the vault it admits.
///
/// The redemption is a conditional `UPDATE`; only the caller whose update
/// touched a row goes on to create the vault, which is what makes an invite
/// single-use under a race between two phones.
///
/// # Errors
///
/// [`InviteRefusal`] wrapped in a store fault's absence, or a store fault.
pub async fn redeem(
    store: &mut SqliteState,
    code: &str,
    vault: VaultId,
    account: AccountId,
    now: ServerTime,
    append_only: bool,
) -> Result<Result<Plan, InviteRefusal>, StoreFault> {
    let hash = code_hash(code);
    let Some(record) = read(store, &hash)? else {
        return Ok(Err(InviteRefusal::Unknown));
    };
    if record.redeemed_at.is_some() {
        return Ok(Err(InviteRefusal::AlreadyRedeemed));
    }
    if now > record.expires_at {
        return Ok(Err(InviteRefusal::Expired));
    }

    let claimed = store
        .connection()?
        .execute(
            sql::INVITE_REDEEM,
            params![hash.as_slice(), now.millis(), account.as_bytes().as_slice()],
        )
        .map_err(|error| StoreFault::new(error.to_string()))?;
    if claimed == 0 {
        // Somebody else's UPDATE got there first.
        return Ok(Err(InviteRefusal::AlreadyRedeemed));
    }

    let plan = Plan::active(record.quota_bytes);
    state::register(store, vault, account, plan, append_only).await?;
    Ok(Ok(plan))
}

/// One invite, by its hash.
///
/// # Errors
///
/// A store fault.
pub fn read(store: &SqliteState, hash: &[u8; 32]) -> Result<Option<InviteRecord>, StoreFault> {
    store
        .connection()?
        .query_row(sql::INVITE_SELECT, params![hash.as_slice()], record)
        .optional()
        .map_err(|error| StoreFault::new(error.to_string()))
}

/// Every invite, for the owner's listing.
///
/// # Errors
///
/// A store fault.
pub fn list(store: &SqliteState) -> Result<Vec<InviteRecord>, StoreFault> {
    let connection = store.connection()?;
    let mut statement = connection
        .prepare(sql::INVITES_SELECT)
        .map_err(|error| StoreFault::new(error.to_string()))?;
    let rows = statement
        .query_map([], record)
        .map_err(|error| StoreFault::new(error.to_string()))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|error| StoreFault::new(error.to_string()))?);
    }
    Ok(out)
}

fn record(row: &rusqlite::Row<'_>) -> rusqlite::Result<InviteRecord> {
    let hash: Vec<u8> = row.get(0)?;
    let redeemed_by: Option<Vec<u8>> = row.get(5)?;
    Ok(InviteRecord {
        code_hash: <[u8; 32]>::try_from(hash.as_slice()).unwrap_or([0; 32]),
        quota_bytes: row.get::<_, i64>(1)?.try_into().unwrap_or(0),
        created_at: ServerTime::from_millis(row.get(2)?),
        expires_at: ServerTime::from_millis(row.get(3)?),
        redeemed_at: row.get::<_, Option<i64>>(4)?.map(ServerTime::from_millis),
        redeemed_by: redeemed_by.as_deref().and_then(Key32::from_slice),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SqliteState {
        SqliteState::in_memory().expect("an in-memory state file")
    }

    fn at(millis: i64) -> ServerTime {
        ServerTime::from_millis(millis)
    }

    /// THE SERVER HOLDS THE HASH AND NOT THE INVITE. A stolen state file is not
    /// a set of working invitations.
    #[test]
    fn a_minted_invite_is_not_in_the_state_file() {
        let store = store();
        let invite = mint(&store, 8 * crate::config::GIB, at(1_000)).expect("mint");
        let dump = store.dump().expect("dump");
        assert!(
            !dump.contains(&invite.code),
            "the invite code itself is in the state file"
        );
        assert!(
            dump.contains(&hex::encode(code_hash(&invite.code))),
            "the hash is what is stored, and it is"
        );
    }

    /// AN INVITE IS SINGLE-USE. The second redemption is refused, and the
    /// refusal does not say which of the three reasons it was.
    #[tokio::test]
    async fn an_invite_redeems_once_and_then_never_again() {
        let mut store = store();
        let invite = mint(&store, 4 * crate::config::GIB, at(1_000)).expect("mint");
        let first = redeem(
            &mut store,
            &invite.code,
            Key32::from_bytes([1; 32]),
            Key32::from_bytes([2; 32]),
            at(2_000),
            false,
        )
        .await
        .expect("no store fault");
        assert!(first.is_ok(), "{first:?}");

        let second = redeem(
            &mut store,
            &invite.code,
            Key32::from_bytes([3; 32]),
            Key32::from_bytes([4; 32]),
            at(3_000),
            false,
        )
        .await
        .expect("no store fault");
        assert_eq!(second, Err(InviteRefusal::AlreadyRedeemed));
    }

    /// An invite nobody minted and an invite that expired are the same answer
    /// to the caller: `InviteRefusal`'s `Display` is one sentence for all three.
    #[test]
    fn every_invite_refusal_says_the_same_thing_on_the_wire() {
        assert_eq!(InviteRefusal::Unknown.to_string(), "gateway: invite");
        assert_eq!(InviteRefusal::Expired.to_string(), "gateway: invite");
        assert_eq!(
            InviteRefusal::AlreadyRedeemed.to_string(),
            "gateway: invite"
        );
    }

    #[tokio::test]
    async fn an_expired_invite_is_refused() {
        let mut store = store();
        let invite = mint(&store, crate::config::GIB, at(1_000)).expect("mint");
        let outcome = redeem(
            &mut store,
            &invite.code,
            Key32::from_bytes([1; 32]),
            Key32::from_bytes([2; 32]),
            at(1_000 + INVITE_LIFETIME_MS + 1),
            false,
        )
        .await
        .expect("no store fault");
        assert_eq!(outcome, Err(InviteRefusal::Expired));
    }

    /// THE QUOTA COMES FROM THE INVITE, and it is a number rather than an
    /// absence: keys are free to mint (F13).
    #[tokio::test]
    async fn a_redeemed_vault_carries_the_invites_quota() {
        use centraid_gateway_core::store::StateStore as _;

        let mut store = store();
        let invite = mint(&store, 7 * crate::config::GIB, at(1_000)).expect("mint");
        let vault = Key32::from_bytes([9; 32]);
        redeem(
            &mut store,
            &invite.code,
            vault,
            Key32::from_bytes([8; 32]),
            at(2_000),
            false,
        )
        .await
        .expect("no store fault")
        .expect("redeemed");

        let held = store
            .vault(&vault)
            .await
            .expect("read")
            .expect("registered");
        assert_eq!(held.plan.quota_bytes, 7 * crate::config::GIB);
        assert!(!held.append_only, "Q24: off by default");
    }
}
