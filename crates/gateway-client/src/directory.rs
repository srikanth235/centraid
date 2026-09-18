//! Which gateway, and how a member gets onto one (#1029 §3, W5B-3).
//!
//! Three things a member does that are not a request about a vault's bytes:
//!
//! 1. **add a gateway and switch to it** — a self-hoster's box, or the hosted
//!    offering, or both;
//! 2. **redeem an invite** on a standalone server, which is the one endpoint
//!    that is a deployment's own;
//! 3. **register a hosted account**, where the payment platform's receipt has
//!    to reach an account the server knows without the server learning who paid.
//!
//! # THE GATEWAY IS A SETTING, AND SWITCHING IS NOT A MIGRATION
//!
//! [`Directory`] holds gateways and names one as current *per vault*, because a
//! vault's objects live where they were uploaded — a household may keep one
//! vault on a self-hosted box and another on the hosted offering, and a single
//! "current gateway" would be a setting that silently moved somebody's
//! photographs. Switching a vault's gateway changes where the *next* commit
//! goes and moves nothing; the old gateway still holds what it held, which is
//! why [`Directory::switch`] returns the gateway that was displaced rather than
//! dropping it.
//!
//! # `appAccountToken` IS A UUID AND NOTHING ELSE (F13, Q15)
//!
//! Apple's `appAccountToken` is the only field a receipt carries that the app
//! chooses, and it is the join between "somebody paid" and "this account key
//! has quota". It must be a **random UUID mapped server-side**, never the
//! account key and never anything derived from it: the value reaches Apple, and
//! an account key that reached Apple would tie a person's payment identity to
//! the address every one of their vaults is published under.
//!
//! **No price and no licence text is encoded anywhere in this module.** Q15 and
//! Q16 are open with the owner; what is built here is the mechanism.

use std::collections::BTreeMap;

use centraid_gateway_core::ids::{AccountId, VaultId};
use centraid_identity::GatewayUrl;
use serde::Deserialize;

use crate::outcome::{ClientError, ErrorBody};
use crate::transport::{HttpRequest, Transport};

/// A gateway a member has added.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gateway {
    /// Its base URL, checked once at the edge by `centraid_identity`.
    pub url: GatewayUrl,
    /// What a member called it. Their word, never derived from the host: a
    /// member who calls their box "the shed" should see "the shed".
    pub label: String,
}

/// The gateways this phone knows, and which one each vault is on.
#[derive(Debug, Clone, Default)]
pub struct Directory {
    gateways: Vec<Gateway>,
    current: BTreeMap<[u8; 32], GatewayUrl>,
}

impl Directory {
    /// An empty directory — a phone before setup.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a gateway, or rename one already here.
    ///
    /// Keyed by URL: adding the same box twice under two labels would give a
    /// member two rows that are one thing, and a switcher they cannot reason
    /// about.
    pub fn add(&mut self, gateway: Gateway) {
        if let Some(existing) = self
            .gateways
            .iter_mut()
            .find(|held| held.url.as_str() == gateway.url.as_str())
        {
            existing.label = gateway.label;
            return;
        }
        self.gateways.push(gateway);
    }

    /// Every gateway, in the order they were added.
    #[must_use]
    pub fn gateways(&self) -> &[Gateway] {
        &self.gateways
    }

    /// Where this vault's next commit goes.
    #[must_use]
    pub fn current(&self, vault: &VaultId) -> Option<&GatewayUrl> {
        self.current.get(vault.as_bytes())
    }

    /// Point a vault at a gateway, and answer with the one it was on.
    ///
    /// **Nothing moves.** The old gateway still holds every object it held, and
    /// the member can switch back. A switch that deleted would be a switch that
    /// loses a vault when somebody taps the wrong row.
    ///
    /// # Errors
    ///
    /// [`SwitchRefused`] when the gateway is not one this phone has added —
    /// a vault pointed at a URL the member never entered is a vault whose bytes
    /// go somewhere nobody chose.
    pub fn switch(
        &mut self,
        vault: &VaultId,
        url: &GatewayUrl,
    ) -> Result<Option<GatewayUrl>, SwitchRefused> {
        if !self
            .gateways
            .iter()
            .any(|held| held.url.as_str() == url.as_str())
        {
            return Err(SwitchRefused::NotAdded {
                url: url.as_str().to_owned(),
            });
        }
        Ok(self.current.insert(*vault.as_bytes(), url.clone()))
    }
}

/// Why a switch was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SwitchRefused {
    /// The gateway is not in the directory.
    #[error("{url} is not a gateway this phone has added")]
    NotAdded {
        /// The URL that was asked for.
        url: String,
    },
}

/// What a standalone server answered an invite with.
///
/// It carries a quota and an append-only flag and **no price**: what a
/// self-hoster charges, if anything, is not this protocol's business, and Q15
/// is open for the hosted offering.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Admission {
    /// The bytes this vault may store.
    pub quota_bytes: u64,
    /// Whether this deployment refuses tombstones (F10).
    pub append_only: bool,
}

/// Redeem an invite on a standalone gateway.
///
/// **Unsigned, and it must be**: this is how a vault becomes known to a server
/// at all, and a signature would be verified against a registration that does
/// not exist yet. Every invite refusal is the same answer on the server's side,
/// so a caller cannot enumerate which invites a household has minted.
///
/// # Errors
///
/// [`ClientError::Refused`] with `Unauthorized` for any invite the server did
/// not accept — which is deliberately indistinguishable from an unknown vault.
pub async fn redeem_invite<T: Transport>(
    transport: &T,
    vault: &VaultId,
    account: &AccountId,
    invite: &str,
) -> Result<Admission, ClientError> {
    let body = serde_json::to_vec(&serde_json::json!({
        "invite": invite,
        "account": account.hex(),
    }))
    .map_err(|error| ClientError::Malformed {
        reason: error.to_string(),
    })?;
    let response = transport
        .send(HttpRequest {
            method: "POST".to_owned(),
            path: format!("/v1/vaults/{}/admit", vault.hex()),
            headers: [("content-type".to_owned(), "application/json".to_owned())]
                .into_iter()
                .collect(),
            body,
        })
        .await?;
    if response.status >= 400 {
        let refusal: ErrorBody =
            serde_json::from_slice(&response.body).map_err(|error| ClientError::Malformed {
                reason: error.to_string(),
            })?;
        return Err(ClientError::from_body(response.status, &refusal));
    }
    serde_json::from_slice(&response.body).map_err(|error| ClientError::Malformed {
        reason: error.to_string(),
    })
}

/// The token a hosted purchase carries, and the mapping the phone keeps.
///
/// The token goes to the payment platform; the mapping stays here. A server
/// that learns the pair can grant quota to an account key without learning who
/// paid for it, and the payment platform learns a UUID and no key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PurchaseToken {
    /// The `appAccountToken`: 16 random bytes in UUID form. **Never derived
    /// from the account key** — see the module header.
    pub token: String,
    /// The account it maps to, hex. Kept on the phone and sent to the gateway,
    /// never to the payment platform.
    pub account: String,
}

impl PurchaseToken {
    /// Mint a token from 16 bytes of platform entropy.
    ///
    /// The bytes are an argument rather than drawn here for the reason
    /// `gateway-core` gives about randomness: this code compiles into places
    /// with no ambient generator, and a caller that has one is the caller that
    /// should be trusted with it.
    #[must_use]
    pub fn mint(entropy: [u8; 16], account: &AccountId) -> Self {
        let hex = hex::encode(entropy);
        Self {
            token: format!(
                "{}-{}-{}-{}-{}",
                &hex[0..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..32]
            ),
            account: account.hex(),
        }
    }
}

#[cfg(test)]
mod tests {
    use centraid_gateway_core::ids::Key32;

    use super::*;

    fn url(text: &str) -> GatewayUrl {
        GatewayUrl::parse(text).expect("a usable gateway URL")
    }

    fn vault(byte: u8) -> VaultId {
        Key32::from_bytes([byte; 32])
    }

    /// TWO VAULTS, TWO GATEWAYS. The setting is per vault because a vault's
    /// objects live where they were uploaded.
    #[test]
    fn two_vaults_can_sit_on_two_gateways() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "the shed".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://hosted.example"),
            label: "Centraid".to_owned(),
        });
        directory
            .switch(&vault(1), &url("https://shed.example"))
            .expect("added");
        directory
            .switch(&vault(2), &url("https://hosted.example"))
            .expect("added");
        assert_eq!(
            directory.current(&vault(1)).map(GatewayUrl::as_str),
            Some("https://shed.example/")
        );
        assert_eq!(
            directory.current(&vault(2)).map(GatewayUrl::as_str),
            Some("https://hosted.example/")
        );
    }

    /// SWITCHING IS NOT A MIGRATION, and the displaced gateway comes back so a
    /// member can be told where the old copy still is.
    #[test]
    fn a_switch_answers_with_the_gateway_it_displaced() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://one.example"),
            label: "one".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://two.example"),
            label: "two".to_owned(),
        });
        assert_eq!(
            directory.switch(&vault(1), &url("https://one.example")),
            Ok(None)
        );
        assert_eq!(
            directory
                .switch(&vault(1), &url("https://two.example"))
                .expect("added")
                .map(|old| old.as_str().to_owned()),
            Some("https://one.example/".to_owned())
        );
    }

    /// A vault pointed at a URL the member never entered is a vault whose bytes
    /// go somewhere nobody chose.
    #[test]
    fn a_vault_cannot_be_switched_to_a_gateway_nobody_added() {
        let mut directory = Directory::new();
        assert!(matches!(
            directory.switch(&vault(1), &url("https://stranger.example")),
            Err(SwitchRefused::NotAdded { .. })
        ));
    }

    #[test]
    fn adding_the_same_box_twice_renames_it_rather_than_duplicating_it() {
        let mut directory = Directory::new();
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "box".to_owned(),
        });
        directory.add(Gateway {
            url: url("https://shed.example"),
            label: "the shed".to_owned(),
        });
        assert_eq!(directory.gateways().len(), 1);
        assert_eq!(directory.gateways()[0].label, "the shed");
    }

    /// **THE ACCOUNT KEY NEVER REACHES THE PAYMENT PLATFORM.** The token is
    /// entropy, and nothing about it is derived from the key it maps to.
    #[test]
    fn a_purchase_token_is_entropy_and_not_the_account_key() {
        let account = Key32::from_bytes([7_u8; 32]);
        let token = PurchaseToken::mint([3_u8; 16], &account);
        assert_eq!(token.token, "03030303-0303-0303-0303-030303030303");
        assert!(
            !token.token.contains(&account.hex()[0..8]),
            "no part of the account key is in the token"
        );
        assert_eq!(token.account, account.hex());
    }

    /// Two mints from different entropy are different tokens; the mapping is
    /// the only thing that ties either to an account.
    #[test]
    fn two_tokens_for_one_account_are_not_equal() {
        let account = Key32::from_bytes([7_u8; 32]);
        assert_ne!(
            PurchaseToken::mint([1_u8; 16], &account).token,
            PurchaseToken::mint([2_u8; 16], &account).token
        );
    }
}
